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
 * 任一層讀取失敗會列出「（讀取失敗）」視窗，且剩餘額度改為「最多」的上界，不假裝資料完整。
 */

import { getManagementBase } from "./protocol.js";
import type { MagpieUsageResponse, MagpieUsageWindow } from "./types.js";

/** budget_limits 的單一視窗（同一個實體可同時有多個獨立視窗） */
interface BudgetLimitEntry {
  budget_duration?: string;
  max_budget?: number | null;
  reset_at?: string | null;
}

/** model_max_budget_usage 的單一模型條目 */
interface ModelBudgetUsage {
  current_spend?: number;
  budget_limit?: number | string;
  time_period?: string;
}

/** 一層預算（key / user / team / team 成員）共用的欄位形狀 */
interface BudgetBlock {
  spend?: number | null;
  max_budget?: number | null;
  budget_duration?: string | null;
  budget_reset_at?: string | null;
  budget_limits?: BudgetLimitEntry[] | null;
  budget_limits_usage?: Record<string, { current_spend?: number }> | null;
  model_max_budget_usage?: Record<string, ModelBudgetUsage> | null;
}

interface KeyInfo extends BudgetBlock {
  user_id?: string | null;
  team_id?: string | null;
}

interface TeamMembership {
  user_id?: string | null;
  spend?: number | null;
  litellm_budget_table?: BudgetBlock | null;
}

interface TeamInfo extends BudgetBlock {
  /** 團隊對每位成員的預設上限（LiteLLM 的 team_member_budget），成員沒有個別上限時套用 */
  team_member_budget?: number | null;
  team_member_budget_duration?: string | null;
}

interface TeamInfoResponse {
  team_info?: TeamInfo;
  team_memberships?: TeamMembership[];
}

/** 一層預算正規化後的結構，與 LiteLLM 的 JSON 形狀解耦 */
interface Scope {
  level: "Key" | "User" | "Team" | "Team 成員";
  spend: number;
  max: number | null;
  duration: string | null;
  resetAt: string | undefined;
  limits: BudgetLimitEntry[];
  limitUsage: Record<string, { current_spend?: number }>;
  models: Record<string, ModelBudgetUsage>;
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
 * 解析 duration 字串（例如 "30d", "7d", "24h"）為秒數
 * @private
 */
export function parseDurationToSeconds(duration?: string): number | undefined {
  if (!duration) return undefined;
  const match = String(duration).trim().match(/^(\d+)([dhms])$/i);
  if (!match) return undefined;
  const val = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "d") return val * 86400;
  if (unit === "h") return val * 3600;
  if (unit === "m") return val * 60;
  if (unit === "s") return val;
  return undefined;
}

/**
 * 將 LiteLLM 的 budget_duration / time_period 轉為中文週期
 * 例："1h" -> 每小時、"24h" / "1d" -> 每日、"7d" -> 每週、"30d" / "1mo" -> 每月、"12mo" -> 每年
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
 * 正數才視為有效上限；0、null、負數視為無上限
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
 * 有明確上限且用量已知的視窗。會擋請求者帶 used（百分比）與 cap；團隊金鑰不計者標為 aside 且不擋
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
    span: parseDurationToSeconds(duration ?? undefined),
  };
  if (!enforced) {
    return { window: { ...window, name: `${name}（團隊金鑰不計）`, aside: true }, rank: 1, pct: 0 };
  }
  const pct = Math.min(100, Math.round((spend / max) * 100));
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
function unknownUsagePart(name: string, max: number, duration: string, enforced: boolean): Part {
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
  const name = useCumulative
    ? `${scope.level} 累計花費`
    : `${scope.level} · ${formatPeriod(scope.duration)} 花費`;
  return {
    window: { name, display: `$${scope.spend.toFixed(2)}`, aside: true },
    rank: 2,
    pct: 0,
  };
}

/**
 * 讀取失敗的層：列出提醒，不計入剩餘額度
 * @private
 */
function failedLayerPart(level: string): Part {
  return { window: { name: `${level}（讀取失敗）`, display: "讀取失敗，未計入剩餘額度" }, rank: 1, pct: 0 };
}

/**
 * 一層預算展開為視窗：主上限、每個有效的 budget_limits 視窗各一條；無上限則只列花費資訊
 * @private
 */
function scopeParts(scope: Scope): Part[] {
  const parts: Part[] = [];

  if (scope.max !== null) {
    const name = `${scope.level} · ${formatPeriod(scope.duration) || "上限"}`;
    parts.push(capPart(name, scope.spend, scope.max, scope.resetAt, scope.duration, scope.enforced));
  }

  for (const entry of scope.limits) {
    const max = positive(entry.max_budget);
    if (max === null || !entry.budget_duration) continue;
    const name = `${scope.level} · ${formatPeriod(entry.budget_duration)}`;
    const used = scope.limitUsage[entry.budget_duration]?.current_spend;
    parts.push(
      typeof used === "number"
        ? capPart(name, used, max, toIso(entry.reset_at), entry.budget_duration, scope.enforced)
        : unknownUsagePart(name, max, entry.budget_duration, scope.enforced),
    );
  }

  if (parts.length === 0) {
    if (scope.spend > 0) parts.push(spendPart(scope, false));
    return parts;
  }
  // 有上限時，Key 的累計花費仍以資訊列呈現（與舊版行為一致）
  if (scope.level === "Key" && scope.spend > 0) parts.push(spendPart(scope, true));
  return parts;
}

/**
 * 正規化一層預算的結構
 * @private
 */
function toScope(level: Scope["level"], block: BudgetBlock, spend: number, enforced: boolean): Scope {
  return {
    level,
    spend,
    max: positive(block.max_budget),
    duration: block.budget_duration ?? null,
    resetAt: toIso(block.budget_reset_at),
    limits: Array.isArray(block.budget_limits) ? block.budget_limits : [],
    limitUsage: block.budget_limits_usage ?? {},
    models: block.model_max_budget_usage ?? {},
    enforced,
  };
}

/**
 * 團隊預設的成員上限，取自 team_member_budget；未設定則 undefined
 * @private
 */
function teamDefaultBlock(team: TeamInfo): BudgetBlock | undefined {
  if (positive(team.team_member_budget) === null) return undefined;
  return { max_budget: team.team_member_budget, budget_duration: team.team_member_budget_duration };
}

/**
 * 成員實際適用的預算，對齊 LiteLLM resolve_effective_team_member_budget：
 * 成員個別上限優先，否則套團隊預設；兩者皆無時，只有 budget_limits 的成員才列出自己的視窗
 * @private
 */
function effectiveMemberBlock(
  row: BudgetBlock | null | undefined,
  teamDefault: BudgetBlock | undefined,
): BudgetBlock | undefined {
  if (positive(row?.max_budget) !== null) return row ?? undefined;
  if (teamDefault) return teamDefault;
  return row?.budget_limits?.length ? row : undefined;
}

/**
 * 各層的 per-model 預算合併為一條字串摘要（不展開成多條視窗）。團隊金鑰下不計的層不列入
 * @private
 */
function modelSummaryWindow(scopes: Scope[]): MagpieUsageWindow | undefined {
  const parts: string[] = [];
  for (const scope of scopes) {
    if (!scope.enforced) continue;
    for (const [model, usage] of Object.entries(scope.models)) {
      const limit = Number(usage?.budget_limit);
      if (!Number.isFinite(limit) || limit <= 0) continue;
      const spent = typeof usage.current_spend === "number" ? usage.current_spend : 0;
      const period = formatPeriod(usage.time_period);
      parts.push(`${scope.level} · ${model} $${limit.toFixed(2)}${period ? ` ${period}` : ""}（已用 $${spent.toFixed(2)}）`);
    }
  }
  if (parts.length === 0) return undefined;
  return { name: "模型額度", display: parts.join("；") };
}

/**
 * 剩餘額度：所有會擋請求的上限中，剩餘金額最少者（最先擋住請求的那一個）。
 * 用量未取得的上限以 limit 作上界。只要有任何不確定（用量未取得或某層讀取失敗），前面加「最多」。
 * @private
 */
function pickBalance(parts: Part[], keySpend: number, layerFailed: boolean): string {
  const caps = parts.flatMap((p) => (p.cap ? [p.cap] : []));
  if (caps.length === 0) return `$${keySpend.toFixed(2)} spent`;

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
 * GET 一個管理端點；失敗（網路、非 2xx、非 JSON）回傳 undefined，由呼叫端決定降級方式
 * @private
 */
async function getJson<T>(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<T | undefined> {
  try {
    const res = await fetch(url, { headers, signal });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * 查詢 LiteLLM 的多層級預算並轉換為 Magpie Usage 格式
 * 層級：Key（含多視窗與 per-model）、User（團隊金鑰下只顯示）、Team（僅團隊金鑰）、Team 成員（有效成員預算時）
 */
export async function queryLiteLLMBudget(
  rawBaseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<MagpieUsageResponse> {
  const rootUrl = getManagementBase(rawBaseUrl);
  const headers = { Authorization: `Bearer ${apiKey}` };

  const keyRes = await getJson<{ info?: KeyInfo }>(`${rootUrl}/key/info`, headers, signal);
  const info = keyRes?.info;
  if (!info) {
    return { plan: "LiteLLM Proxy", user: "LiteLLM User", windows: [], error: "無法取得 LiteLLM 金鑰資訊" };
  }

  const userId = info.user_id ?? undefined;
  const teamId = info.team_id ?? undefined;
  const isTeamKey = Boolean(teamId);

  const [userRes, teamRes] = await Promise.all([
    userId
      ? getJson<{ user_info?: BudgetBlock }>(`${rootUrl}/user/info?user_id=${encodeURIComponent(userId)}`, headers, signal)
      : Promise.resolve(undefined),
    teamId
      ? getJson<TeamInfoResponse>(`${rootUrl}/team/info?team_id=${encodeURIComponent(teamId)}`, headers, signal)
      : Promise.resolve(undefined),
  ]);

  const scopes: Scope[] = [toScope("Key", info, info.spend ?? 0, true)];
  const failures: Part[] = [];

  const userInfo = userRes?.user_info;
  if (userInfo) {
    scopes.push(toScope("User", userInfo, userInfo.spend ?? 0, !isTeamKey));
  } else if (userId && !isTeamKey) {
    // 團隊金鑰的 User 層不計入剩餘額度，讀取失敗不影響結果
    failures.push(failedLayerPart("User"));
  }

  const teamInfo = teamRes?.team_info;
  if (teamId && !teamInfo) {
    failures.push(failedLayerPart("Team"));
  }
  if (teamInfo) {
    scopes.push(toScope("Team", teamInfo, teamInfo.spend ?? 0, true));
    const membership = userId ? teamRes?.team_memberships?.find((m) => m.user_id === userId) : undefined;
    const member = userId ? effectiveMemberBlock(membership?.litellm_budget_table, teamDefaultBlock(teamInfo)) : undefined;
    if (member) scopes.push(toScope("Team 成員", member, membership?.spend ?? 0, true));
  }

  const parts: Part[] = [...scopes.flatMap(scopeParts), ...failures];
  const modelWindow = modelSummaryWindow(scopes);
  if (modelWindow) parts.push({ window: modelWindow, rank: 2, pct: 0 });
  parts.sort(comparePart);

  return {
    plan: "LiteLLM Proxy",
    user: userId || "LiteLLM User",
    balance: pickBalance(parts, info.spend ?? 0, failures.length > 0),
    windows: parts.map((p) => p.window),
  };
}
