/**
 * @fileoverview LiteLLM 多層級預算探測與 Magpie Quota 轉譯
 *
 * 資料來源（LiteLLM 文件與原始碼，2026-11 查證）：
 * - /key/info：spend、max_budget、budget_duration、budget_reset_at、budget_limits、
 *   budget_limits_usage（各視窗目前用量）、model_max_budget_usage（各模型目前用量）
 * - /user/info?user_id=：同上（virtual key 只能讀到自己）
 * - /team/info?team_id=：team_info（spend、max_budget、budget_limits、team_member_budget 團隊預設）
 *   與 team_memberships（成員自己的 litellm_budget_table）
 * - 團隊金鑰（key.team_id 非空）不套用個人（User）預算，該層只顯示、不計入剩餘額度
 * - 成員預算對齊 LiteLLM 的 resolve_effective_team_member_budget：成員個別上限優先，否則套團隊預設
 *
 * 規格出處：
 * - 預算欄位與 budget_limits：https://github.com/BerriAI/litellm/blob/main/litellm/proxy/_types.py
 * - duration 格式（s/m/h/d/w/mo）：https://github.com/BerriAI/litellm/blob/main/litellm/litellm_core_utils/duration_parser.py
 * - 重設時間對齊（1d 每日、7d 週一、30d 每月 1 日）：https://docs.litellm.ai/docs/proxy/budget_reset_and_tz
 * - max_budget 為 0 仍是有效上限（判斷為 `max_budget is not None`）：https://github.com/BerriAI/litellm/blob/main/litellm/proxy/auth/auth_checks.py
 * - Magpie usage 回傳格式（used 未知時不可給 0、aside 不擋請求）：https://usemagpie.ai/docs/plugins
 *
 * 所有外部回應在 boundary 以 Zod 驗證，之後只用 z.infer 出來的型別。
 * 缺少或格式錯誤的花費不視為 0；格式錯誤的巢狀條目會略過並標示「部分視窗讀取失敗」。
 * 任一層讀取失敗會列出「（讀取失敗）」視窗，且剩餘額度改為「最多」的上界，不假裝資料完整。
 */

import { z } from "zod";
import { getManagementBase } from "./protocol.js";
import type { MagpieUsageResponse, MagpieUsageWindow } from "./types.js";

/** 一層預算共用的欄位；巢狀陣列與物件保持 unknown，交由逐條目驗證 */
const BudgetBlockSchema = z.object({
  spend: z.number().nullish(),
  max_budget: z.number().nonnegative().nullish(),
  budget_duration: z.string().nullish(),
  budget_reset_at: z.string().nullish(),
  budget_limits: z.unknown().optional(),
  budget_limits_usage: z.unknown().optional(),
  model_max_budget_usage: z.unknown().optional(),
});

/** budget_limits 的單一視窗（同一個實體可同時有多個獨立視窗）；max_budget 為 null 代表此視窗無上限 */
const BudgetLimitEntrySchema = z.object({
  budget_duration: z.string(),
  max_budget: z.number().nonnegative().nullable(),
  reset_at: z.string().nullish(),
});

/** budget_limits_usage 的單一視窗用量 */
const WindowUsageSchema = z.object({ current_spend: z.number().nullish() });

/** model_max_budget_usage 的單一模型條目；budget_limit 可能是數字或數字字串 */
const ModelBudgetUsageSchema = z.object({
  current_spend: z.number().nullish(),
  budget_limit: z.union([z.number(), z.string().trim().min(1)]),
  time_period: z.string().nullish(),
});

const KeyInfoSchema = BudgetBlockSchema.extend({
  user_id: z.string().nullish(),
  team_id: z.string().nullish(),
  /** TPM 只作顯示，不影響預算計算，因此解析失敗時直接不顯示 */
  tpm_limit: z.unknown().optional(),
});

const KeyInfoResponseSchema = z.object({ info: KeyInfoSchema });

const UserInfoResponseSchema = z.object({ user_info: BudgetBlockSchema });

const TeamInfoSchema = BudgetBlockSchema.extend({
  /** 團隊對每位成員的預設上限（LiteLLM 的 team_member_budget），成員沒有個別上限時套用 */
  team_member_budget: z.number().nonnegative().nullish(),
  team_member_budget_duration: z.string().nullish(),
  tpm_limit: z.unknown().optional(),
});

const MembershipSchema = z.object({
  user_id: z.string(),
  spend: z.number().nullish(),
  litellm_budget_table: BudgetBlockSchema.nullish(),
});

const TeamInfoResponseSchema = z.object({
  team_info: z.unknown().optional(),
  team_memberships: z.unknown().optional(),
});

const UserIdSchema = z.object({ user_id: z.string() });

type BudgetBlock = z.infer<typeof BudgetBlockSchema>;
type BudgetLimitEntry = z.infer<typeof BudgetLimitEntrySchema>;
type Membership = z.infer<typeof MembershipSchema>;
type TeamInfo = z.infer<typeof TeamInfoSchema>;

type Level = "Key" | "User" | "Team" | "Team 成員";

/** 一個已驗證的 per-model 預算條目 */
interface ModelUsage {
  model: string;
  limit: number;
  spent: number | undefined;
  period: string | null;
}

/** 一層預算正規化後的結構，與 LiteLLM 的 JSON 形狀解耦；spend 為 undefined 代表用量未取得 */
interface Scope {
  level: Level;
  spend: number | undefined;
  max: number | null;
  duration: string | null;
  resetAt: string | undefined;
  limits: BudgetLimitEntry[];
  invalidLimits: number;
  limitUsage: Record<string, number | undefined>;
  models: ModelUsage[];
  invalidModels: number;
  /** false 代表此層不會擋請求（例如團隊金鑰下的個人預算） */
  enforced: boolean;
}

/** 會擋請求的上限。remaining 為 undefined 代表用量未取得，此時 limit 是剩餘額度的上界 */
interface Cap {
  name: string;
  limit: number;
  remaining: number | undefined;
}

/**
 * 輸出前的內部視窗。rank：0 會擋請求的上限、1 不擋或需提醒（團隊金鑰不計、讀取失敗）、2 純資訊
 * cap 只有會擋請求的上限才帶，用來計算剩餘額度
 */
interface Part {
  window: MagpieUsageWindow;
  rank: number;
  /** 上限已用百分比，同一 rank 內排序用 */
  pct: number;
  cap?: Cap;
}

/**
 * 解析 duration 字串（例如 "30d", "7d", "24h", "1w"）為秒數。
 * 只接受 LiteLLM 有固定長度的單位（s/m/h/d/w）；"mo" 是日曆月，沒有固定秒數，回傳 undefined。
 * @private
 */
export function parseDurationToSeconds(duration?: string | null): number | undefined {
  if (!duration) return undefined;
  const match = duration.trim().match(/^(\d+)([dhmsw])$/i);
  if (!match) return undefined;
  const val = Number(match[1]);
  if (!Number.isSafeInteger(val) || val <= 0) return undefined;
  const secondsPerUnit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return val * secondsPerUnit[match[2].toLowerCase()];
}

/**
 * 將 LiteLLM 的 budget_duration / time_period 轉為中文週期
 * 例："1h" -> 每小時、"24h" / "1d" -> 每日、"7d" / "1w" -> 每週、"30d" / "1mo" -> 每月、"12mo" -> 每年
 */
export function formatPeriod(duration?: string | null): string {
  if (!duration) return "";
  const trimmed = duration.trim();

  const months = trimmed.match(/^(\d+)mo$/i);
  if (months) {
    const n = Number(months[1]);
    if (n === 1) return "每月";
    if (n === 12) return "每年";
    return `每 ${n} 個月`;
  }

  const named: Record<number, string> = {
    3600: "每小時",
    86400: "每日",
    604800: "每週",
    2592000: "每月",
    31536000: "每年",
  };
  const seconds = parseDurationToSeconds(trimmed);
  if (seconds !== undefined && named[seconds]) return named[seconds];
  return `每 ${trimmed}`;
}

/**
 * 正數才視為有效的團隊預設值；0、null、負數視為無團隊預設（對齊 LiteLLM 的 team default 判斷）
 * @private
 */
function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

/**
 * 四捨五入到小數點後兩位
 * @private
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * ISO 時間字串正規化；無效時回傳 undefined
 * @private
 */
function toIso(value?: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * @private
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 逐條目驗證陣列；容器本身不是陣列時整體計為一個無效條目
 * @private
 */
function parseEntries<T>(schema: z.ZodType<T>, raw: unknown): { items: T[]; invalid: number } {
  if (raw === undefined || raw === null) return { items: [], invalid: 0 };
  if (!Array.isArray(raw)) return { items: [], invalid: 1 };
  const items: T[] = [];
  let invalid = 0;
  for (const entry of raw) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) items.push(parsed.data);
    else invalid++;
  }
  return { items, invalid };
}

/**
 * 逐值驗證物件；值不合格者為 undefined，代表該 key 的用量未知
 * @private
 */
function parseRecord<T>(schema: z.ZodType<T>, raw: unknown): Record<string, T | undefined> {
  if (!isPlainRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => {
      const parsed = schema.safeParse(value);
      return [key, parsed.success ? parsed.data : undefined];
    }),
  );
}

/**
 * 逐條目驗證 per-model 預算；limit 必須是有限且不為負的數字，否則計為無效
 * @private
 */
function parseModels(raw: unknown): { items: ModelUsage[]; invalid: number } {
  if (raw === undefined || raw === null) return { items: [], invalid: 0 };
  if (!isPlainRecord(raw)) return { items: [], invalid: 1 };
  const items: ModelUsage[] = [];
  let invalid = 0;
  for (const [model, value] of Object.entries(raw)) {
    const parsed = ModelBudgetUsageSchema.safeParse(value);
    const limit = parsed.success ? Number(parsed.data.budget_limit) : Number.NaN;
    if (!parsed.success || !Number.isFinite(limit) || limit < 0) {
      invalid++;
      continue;
    }
    items.push({
      model,
      limit,
      spent: parsed.data.current_spend ?? undefined,
      period: parsed.data.time_period ?? null,
    });
  }
  return { items, invalid };
}

/**
 * 有明確上限且用量已知的視窗。會擋請求者帶 used（百分比）與 cap；團隊金鑰不計者標為 aside 且不擋
 * 上限為 0 時仍是真上限：LiteLLM 會擋請求，所以用量視為已達 100%
 * @private
 */
function capPart(
  name: string,
  spend: number,
  max: number,
  resetAt: string | undefined,
  duration: string | null | undefined,
  enforced: boolean,
): Part {
  const window: MagpieUsageWindow = {
    name,
    amount: round2(spend),
    limit: round2(max),
    unit: "USD",
    display: `$${spend.toFixed(2)} / $${max.toFixed(2)}`,
    resetsAt: resetAt,
    span: parseDurationToSeconds(duration),
  };
  if (!enforced) {
    return { window: { ...window, name: `${name}（團隊金鑰不計）`, aside: true }, rank: 1, pct: 0 };
  }
  const pct = max > 0 ? Math.min(100, Math.round((spend / max) * 100)) : 100;
  return {
    window: { ...window, used: pct },
    rank: 0,
    pct,
    cap: { name, limit: max, remaining: Math.max(0, max - spend) },
  };
}

/**
 * 有上限但用量讀不到：照實標示上限，不假設為 0，剩餘額度以上限為上界
 * @private
 */
function unknownUsagePart(name: string, max: number, duration: string | null | undefined, enforced: boolean): Part {
  const window: MagpieUsageWindow = {
    name: enforced ? name : `${name}（團隊金鑰不計）`,
    limit: round2(max),
    unit: "USD",
    display: `$${max.toFixed(2)} 上限（用量未取得）`,
    span: parseDurationToSeconds(duration),
  };
  if (!enforced) return { window: { ...window, aside: true }, rank: 1, pct: 0 };
  return { window, rank: 0, pct: 0, cap: { name, limit: max, remaining: undefined } };
}

/**
 * 花費資訊列：不擋請求，標為 aside。沒有上限可算比例，所以只給 display、不給 amount，
 * 否則 Magpie 會把它顯示成「0%」這種誤導的百分比。capped 為 true 時代表此層另有上限，這一列只補充累計花費
 * @private
 */
function spendPart(scope: Scope, capped: boolean): Part {
  const useCumulative = capped || !scope.duration;
  const name = useCumulative ? `${scope.level} 累計花費` : `${scope.level} · ${formatPeriod(scope.duration)} 花費`;
  const display = scope.spend === undefined ? "用量未取得" : `$${scope.spend.toFixed(2)}`;
  return { window: { name, display, aside: true }, rank: 2, pct: 0 };
}

/**
 * TPM 設定上限的純顯示列：只列出正整數，不把缺值或無效值當成 0。
 * 沒有即時用量可比對，所以不給 amount、limit、used、resetsAt，也不進入剩餘額度計算。
 * @private
 */
function tpmParts(name: string, tpm: unknown): Part[] {
  const parsed = z.number().nullish().safeParse(tpm);
  const limit = parsed.success ? positive(parsed.data) : null;
  if (limit === null || !Number.isSafeInteger(limit)) return [];
  return [{ window: { name, display: `${limit.toLocaleString("en-US")} tokens/分鐘`, aside: true }, rank: 2, pct: 0 }];
}

/**
 * 讀取失敗的層：列出提醒，不計入剩餘額度
 * @private
 */
function failedLayerPart(level: string): Part {
  return { window: { name: `${level}（讀取失敗）`, display: "讀取失敗，未計入剩餘額度" }, rank: 1, pct: 0 };
}

/**
 * 層內部分條目無法解析：其餘條目照常顯示，但剩餘額度視為不確定
 * @private
 */
function partialFailurePart(level: Level): Part {
  return {
    window: { name: `${level}（部分視窗讀取失敗）`, display: "部分預算視窗格式錯誤，未計入剩餘額度" },
    rank: 1,
    pct: 0,
  };
}

/**
 * 一層預算展開為視窗：主上限、每個有效的 budget_limits 視窗各一條；無上限則只列花費資訊
 * @private
 */
function scopeParts(scope: Scope): Part[] {
  const parts: Part[] = [];

  if (scope.max !== null) {
    const name = `${scope.level} · ${formatPeriod(scope.duration) || "上限"}`;
    parts.push(
      scope.spend === undefined
        ? unknownUsagePart(name, scope.max, scope.duration, scope.enforced)
        : capPart(name, scope.spend, scope.max, scope.resetAt, scope.duration, scope.enforced),
    );
  }

  for (const entry of scope.limits) {
    if (entry.max_budget === null) continue;
    const name = `${scope.level} · ${formatPeriod(entry.budget_duration)}`;
    const used = scope.limitUsage[entry.budget_duration];
    parts.push(
      used === undefined
        ? unknownUsagePart(name, entry.max_budget, entry.budget_duration, scope.enforced)
        : capPart(name, used, entry.max_budget, toIso(entry.reset_at), entry.budget_duration, scope.enforced),
    );
  }

  if (parts.length === 0) {
    if (scope.spend === undefined || scope.spend > 0) parts.push(spendPart(scope, false));
    return parts;
  }
  // 有上限時，Key 的累計花費仍以資訊列呈現（與舊版行為一致）
  if (scope.level === "Key" && (scope.spend === undefined || scope.spend > 0)) parts.push(spendPart(scope, true));
  return parts;
}

/**
 * 會影響剩餘額度判斷的層內部失敗（只針對會擋請求的層）
 * @private
 */
function scopeFailures(scope: Scope): Part[] {
  if (!scope.enforced || scope.invalidLimits === 0) return [];
  return [partialFailurePart(scope.level)];
}

/**
 * 已驗證的預算區塊正規化為一層 Scope
 * @private
 */
function toScope(level: Level, block: BudgetBlock, spend: number | undefined, enforced: boolean): Scope {
  const limits = parseEntries(BudgetLimitEntrySchema, block.budget_limits);
  const usage = parseRecord(WindowUsageSchema, block.budget_limits_usage);
  const models = parseModels(block.model_max_budget_usage);
  return {
    level,
    spend,
    max: block.max_budget ?? null,
    duration: block.budget_duration ?? null,
    resetAt: toIso(block.budget_reset_at),
    limits: limits.items,
    invalidLimits: limits.invalid,
    limitUsage: Object.fromEntries(
      Object.entries(usage).map(([window, value]) => [window, value?.current_spend ?? undefined]),
    ),
    models: models.items,
    invalidModels: models.invalid,
    enforced,
  };
}

/**
 * 團隊預設的成員上限，取自 team_member_budget；未設定或非正數則 undefined
 * @private
 */
function teamDefaultBlock(team: TeamInfo): BudgetBlock | undefined {
  if (positive(team.team_member_budget) === null) return undefined;
  return { max_budget: team.team_member_budget, budget_duration: team.team_member_budget_duration };
}

/**
 * 成員實際適用的預算，對齊 LiteLLM resolve_effective_team_member_budget：
 * 成員個別上限（含 0）優先，否則套團隊預設；兩者皆無時，只有 budget_limits 的成員才列出自己的視窗
 * @private
 */
function effectiveMemberBlock(
  row: BudgetBlock | undefined,
  teamDefault: BudgetBlock | undefined,
): BudgetBlock | undefined {
  if (row && typeof row.max_budget === "number") return row;
  if (teamDefault) return teamDefault;
  return row && Array.isArray(row.budget_limits) && row.budget_limits.length > 0 ? row : undefined;
}

/**
 * 在 team_memberships 找出目前使用者的列。容器或該列格式錯誤回傳 ok: false，代表成員層不可判斷；找不到則 row 為 undefined
 * @private
 */
function findMembership(memberships: unknown, userId: string): { ok: true; row?: Membership } | { ok: false } {
  if (memberships === undefined || memberships === null) return { ok: true };
  if (!Array.isArray(memberships)) return { ok: false };
  const raw = memberships.find((entry) => {
    const parsed = UserIdSchema.safeParse(entry);
    return parsed.success && parsed.data.user_id === userId;
  });
  if (raw === undefined) return { ok: true };
  const parsed = MembershipSchema.safeParse(raw);
  return parsed.success ? { ok: true, row: parsed.data } : { ok: false };
}

/**
 * 各層的 per-model 預算合併為一條字串摘要（不展開成多條視窗）。團隊金鑰下不計的層不列入
 * @private
 */
function modelSummaryWindow(scopes: Scope[]): MagpieUsageWindow | undefined {
  const parts: string[] = [];
  for (const scope of scopes) {
    if (!scope.enforced) continue;
    for (const model of scope.models) {
      const spent = model.spent === undefined ? "已用量未取得" : `已用 $${model.spent.toFixed(2)}`;
      parts.push(
        `${scope.level} · ${model.model} $${model.limit.toFixed(2)}${model.period ? ` ${formatPeriod(model.period)}` : ""}（${spent}）`,
      );
    }
    if (scope.invalidModels > 0) parts.push(`${scope.level} · 部分模型額度格式錯誤，已略過`);
  }
  if (parts.length === 0) return undefined;
  return { name: "模型額度", display: parts.join("；") };
}

/**
 * 剩餘額度：所有會擋請求的上限中，剩餘金額最少者（最先擋住請求的那一個）。
 * 用量未取得的上限以 limit 作上界。只要有任何不確定（用量未取得或某層讀取失敗），前面加「最多」。
 * 沒有任何可用上限時，若有層讀取失敗則回報未知，不以花費總額暗示無限制。
 * @private
 */
function pickBalance(parts: Part[], keySpend: number | undefined, layerFailed: boolean): string {
  const caps = parts.flatMap((p) => (p.cap ? [p.cap] : []));
  if (caps.length === 0) {
    if (layerFailed) return "剩餘額度未知（部分預算讀取失敗）";
    return keySpend === undefined ? "用量未取得" : `$${keySpend.toFixed(2)} spent`;
  }

  const bound = (cap: Cap) => cap.remaining ?? cap.limit;
  const tightest = caps.reduce((a, b) => (bound(b) < bound(a) ? b : a));
  const uncertain = layerFailed || caps.some((cap) => cap.remaining === undefined);
  const label = tightest.remaining === undefined ? `${tightest.name}，用量未取得` : tightest.name;
  return `${uncertain ? "最多 " : ""}$${bound(tightest).toFixed(2)}（${label}）`;
}

/**
 * 排序：會擋請求的上限（用量高的在前）→ 不擋或需提醒 → 純資訊
 * @private
 */
function comparePart(a: Part, b: Part): number {
  return a.rank - b.rank || b.pct - a.pct;
}

/**
 * GET 一個管理端點；失敗（網路、非 2xx、非 JSON）回傳 undefined。回傳值未經驗證，呼叫端需以 schema 解析
 * @private
 */
async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  try {
    const res = await fetch(url, { headers, signal });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * 查詢 LiteLLM 的多層級預算並轉換為 Magpie Usage 格式
 * 層級：Key（含多視窗與 per-model）、User（團隊金鑰下只顯示）、Team（僅團隊金鑰）、Team 成員（有效成員預算時）
 * @example
 * const usage = await queryLiteLLMBudget("http://localhost:4000", apiKey);
 * usage.balance; // "$61.92（Key · 每週）" 或 "最多 $61.92（Key · 每週）"
 */
export async function queryLiteLLMBudget(
  rawBaseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<MagpieUsageResponse> {
  const rootUrl = getManagementBase(rawBaseUrl);
  const headers = { Authorization: `Bearer ${apiKey}` };

  const keyParsed = KeyInfoResponseSchema.safeParse(await getJson(`${rootUrl}/key/info`, headers, signal));
  if (!keyParsed.success) {
    return { plan: "LiteLLM Proxy", user: "LiteLLM User", windows: [], error: "無法取得 LiteLLM 金鑰資訊" };
  }
  const info = keyParsed.data.info;

  const userId = info.user_id ?? undefined;
  const teamId = info.team_id ?? undefined;
  const isTeamKey = Boolean(teamId);

  const [userBody, teamBody] = await Promise.all([
    userId ? getJson(`${rootUrl}/user/info?user_id=${encodeURIComponent(userId)}`, headers, signal) : undefined,
    teamId ? getJson(`${rootUrl}/team/info?team_id=${encodeURIComponent(teamId)}`, headers, signal) : undefined,
  ]);

  const scopes: Scope[] = [toScope("Key", info, info.spend ?? undefined, true)];
  const failures: Part[] = [...scopeFailures(scopes[0])];

  if (userId) {
    const userParsed = UserInfoResponseSchema.safeParse(userBody);
    if (userParsed.success) {
      const scope = toScope(
        "User",
        userParsed.data.user_info,
        userParsed.data.user_info.spend ?? undefined,
        !isTeamKey,
      );
      scopes.push(scope);
      failures.push(...scopeFailures(scope));
    } else if (!isTeamKey) {
      // 團隊金鑰的 User 層不計入剩餘額度，讀取失敗不影響結果
      failures.push(failedLayerPart("User"));
    }
  }

  const teamParsed = teamId ? TeamInfoResponseSchema.safeParse(teamBody) : undefined;
  const teamInfoParsed = teamParsed?.success ? TeamInfoSchema.safeParse(teamParsed.data.team_info) : undefined;
  if (teamId && teamParsed?.success && teamInfoParsed?.success) {
    const teamInfo = teamInfoParsed.data;
    const teamScope = toScope("Team", teamInfo, teamInfo.spend ?? undefined, true);
    scopes.push(teamScope);
    failures.push(...scopeFailures(teamScope));

    if (userId) {
      const membership = findMembership(teamParsed.data.team_memberships, userId);
      if (membership.ok) {
        const block = effectiveMemberBlock(
          membership.row?.litellm_budget_table ?? undefined,
          teamDefaultBlock(teamInfo),
        );
        if (block) {
          const memberScope = toScope("Team 成員", block, membership.row?.spend ?? undefined, true);
          scopes.push(memberScope);
          failures.push(...scopeFailures(memberScope));
        }
      } else {
        failures.push(failedLayerPart("Team 成員"));
      }
    }
  } else if (teamId) {
    // 團隊層失敗時，團隊預設與成員上限都無法判斷
    failures.push(failedLayerPart("Team"));
    if (userId) failures.push(failedLayerPart("Team 成員"));
  }

  const parts: Part[] = [
    ...scopes.flatMap(scopeParts),
    ...failures,
    ...tpmParts("LiteLLM Key TPM 設定上限", info.tpm_limit),
    ...tpmParts("LiteLLM Team TPM 設定上限", teamInfoParsed?.success ? teamInfoParsed.data.tpm_limit : undefined),
  ];
  const modelWindow = modelSummaryWindow(scopes);
  if (modelWindow) parts.push({ window: modelWindow, rank: 2, pct: 0 });
  parts.sort(comparePart);

  return {
    plan: "LiteLLM Proxy",
    user: userId || "LiteLLM User",
    balance: pickBalance(parts, scopes[0].spend, failures.length > 0),
    windows: parts.map((p) => p.window),
  };
}
