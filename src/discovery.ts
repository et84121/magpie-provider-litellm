/**
 * @fileoverview 模型探索：/model/info → /v1/models 的端點階梯，兩條路徑共用同一套模型組裝。
 *
 * 階梯規則（權威性由強到弱）：
 * - /model/info 傳輸失敗、非 2xx、非 JSON、信封不合，或沒有任何可用列（全是損毀或 wildcard）→ 改查 /v1/models。
 * - 信封合法且 data 為空 → 權威的空結果，回傳 {}，不再降級。
 * - 有可用列 → 權威結果。即使全是非對話模型，也不從較弱的 /v1/models 補回來（那會把 embedding 誤推成對話模型）。
 * - 兩階都不可用 → 回傳 undefined，呼叫端保留既有模型清單。
 *
 * wire model ID（id 與 api.id）一律是 LiteLLM 的 model_name：client 以它呼叫，
 * key 與 team 的 models 白名單也比對它（https://docs.litellm.ai/docs/proxy/model_access）。
 * litellm_params.model 是上游部署名，只用來查外部上限，不送上 proxy。
 */

import type { LiteLLMModelInfoEntry } from "./litellm-schema.js";
import { ListEnvelopeSchema, ModelInfoRowSchema, ModelsListRowSchema } from "./litellm-schema.js";
import { type ModelLimit, type ModelsDevCatalog, lookupLimit } from "./limits.js";
import {
  isDecisionModel,
  isExcludedModel,
  knownContextLimit,
  knownOutputLimit,
  resolveContextLimit,
  resolveModelProtocol,
  resolveOutputLimit,
  resolveReasoning,
  UNKNOWN_OUTPUT_FALLBACK,
} from "./protocol.js";
import type { ModelProtocolPackage } from "./types.js";

/** 探索請求的逾時，避免連線黑洞時卡住模型清單 */
export const DISCOVERY_TIMEOUT_MS = 10_000;

/** Magpie 模型清單中的一筆（欄位依 Magpie 外掛規範） */
export interface DiscoveredModel {
  id: string;
  name: string;
  decides?: true;
  api: { id: string; url: string; npm: ModelProtocolPackage };
  limit: { context: number; output: number };
  capabilities: { toolcall: boolean; reasoning: boolean; input: { text: true; image: boolean } };
  cost?: { input: number; output: number };
}

export interface DiscoveryOptions {
  /** LiteLLM 管理端點根路徑（不含 /v1），用於 /model/info */
  rootUrl: string;
  /** LiteLLM 模型呼叫端點（含 /v1），用於 /v1/models 與模型的 api.url */
  apiBase: string;
  apiKey: string;
  /** 預設為全域 fetch；測試可注入 */
  fetcher?: typeof fetch;
  /** 惰性載入外部上限目錄；只有有列缺上限時才會呼叫 */
  loadExternal?: () => Promise<ModelsDevCatalog | undefined>;
  timeoutMs?: number;
}

/** 單一端點的結果：空的權威結果，或至少一個可用列 */
type Listing = { kind: "empty" } | { kind: "rows"; rows: LiteLLMModelInfoEntry[] };

/**
 * 解析 /model/info 單列；不合的列回傳 undefined（略過，不影響其他列）
 * @private
 */
function fromModelInfo(raw: unknown): LiteLLMModelInfoEntry | undefined {
  const parsed = ModelInfoRowSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 解析 /v1/models 單列並轉成無 metadata 的條目
 * @private
 */
function fromModelsList(raw: unknown): LiteLLMModelInfoEntry | undefined {
  const parsed = ModelsListRowSchema.safeParse(raw);
  return parsed.success ? { model_name: parsed.data.id } : undefined;
}

/**
 * 同名的多個部署（負載平衡群組）合併成一列。
 * 基底取第一個有明確 metadata 的部署（沒有則取第一個），避免全空的部署遮蔽有證據的部署。
 * 上限取所有部署中的最小值：請求可能落在任一部署，保守值才不會超過其中任何一個的上限。
 * @private
 */
function mergeDeployments(deployments: LiteLLMModelInfoEntry[]): LiteLLMModelInfoEntry {
  const base = deployments.find(hasExplicitMetadata) ?? deployments[0];
  if (deployments.length === 1) return base;

  const contexts = deployments.map((d) => knownContextLimit(d.model_info)).filter((v) => v !== undefined);
  const outputs = deployments.map((d) => knownOutputLimit(d.model_info)).filter((v) => v !== undefined);
  return {
    ...base,
    model_info: {
      ...base.model_info,
      ...(contexts.length > 0 ? { max_input_tokens: Math.min(...contexts) } : {}),
      ...(outputs.length > 0 ? { max_output_tokens: Math.min(...outputs) } : {}),
    },
  };
}

/**
 * 列是否帶有任何明確的 metadata 欄位（非 null／undefined）
 * @private
 */
function hasExplicitMetadata(entry: LiteLLMModelInfoEntry): boolean {
  const info = entry.model_info;
  if (!info) return false;
  return Object.values(info).some((v) => v !== undefined && v !== null);
}

/**
 * 讀取一個列表端點。傳輸或形狀不合回傳 undefined（交給下一階）；不合格的列只略過該列並記錄數量。
 * @private
 */
async function readListing(
  url: string,
  options: DiscoveryOptions,
  toEntry: (raw: unknown) => LiteLLMModelInfoEntry | undefined,
): Promise<Listing | undefined> {
  const fetcher = options.fetcher ?? fetch;
  try {
    const res = await fetcher(url, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;

    const envelope = ListEnvelopeSchema.safeParse(await res.json());
    if (!envelope.success) return undefined;
    if (envelope.data.data.length === 0) return { kind: "empty" };

    const entries = envelope.data.data.map(toEntry);
    const dropped = entries.filter((entry) => entry === undefined).length;
    if (dropped > 0)
      console.warn(`[magpie-provider-litellm] 略過 ${dropped} 筆無法作為模型 ID 的列（含 wildcard 路由）：${url}`);

    const groups = new Map<string, LiteLLMModelInfoEntry[]>();
    for (const entry of entries) {
      if (entry) groups.set(entry.model_name, [...(groups.get(entry.model_name) ?? []), entry]);
    }
    const rows = [...groups.values()].map(mergeDeployments);
    return rows.length > 0 ? { kind: "rows", rows } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 外部目錄只在「有列缺少上游明確上限」時才需要
 * @private
 */
function needsExternalLimit(entry: LiteLLMModelInfoEntry): boolean {
  return knownContextLimit(entry.model_info) === undefined || knownOutputLimit(entry.model_info) === undefined;
}

/**
 * 依 LiteLLM 的 cost 欄位換算成 Magpie 的每百萬 token 單價；兩者都沒有則不回報
 * @private
 */
function costPerMillion(entry: LiteLLMModelInfoEntry): DiscoveredModel["cost"] {
  const input = entry.model_info?.input_cost_per_token;
  const output = entry.model_info?.output_cost_per_token;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  return { input: (input ?? 0) * 1_000_000, output: (output ?? 0) * 1_000_000 };
}

/**
 * 單一組裝函式：兩條路徑共用。明確證據優先，沒有證據時只用保底值，不依族系猜測上限。
 * @private
 */
function assemble(entry: LiteLLMModelInfoEntry, apiBase: string, external?: ModelLimit): DiscoveredModel {
  const id = entry.model_name;
  const info: NonNullable<LiteLLMModelInfoEntry["model_info"]> = entry.model_info ?? {};
  const isDecision = isDecisionModel(id, entry);
  const cost = costPerMillion(entry);

  return {
    id,
    name: id,
    ...(isDecision ? { decides: true as const } : {}),
    api: { id, url: apiBase, npm: resolveModelProtocol(id, entry) },
    limit: {
      context: resolveContextLimit(info, external?.context),
      output: resolveOutputLimit(info, external?.output),
    },
    capabilities: {
      toolcall: !isDecision && info.supports_function_calling !== false,
      reasoning: !isDecision && resolveReasoning(id, entry),
      input: { text: true, image: !isDecision && info.supports_vision === true },
    },
    ...(cost ? { cost } : {}),
  };
}

/**
 * 把可用列組裝成模型清單。非對話模型（有明確 mode 證據）直接略過。
 * @private
 */
async function assembleAll(
  rows: LiteLLMModelInfoEntry[],
  options: DiscoveryOptions,
): Promise<Record<string, DiscoveredModel>> {
  const included = rows.filter((row) => !isExcludedModel(row.model_name, row));
  const catalog =
    included.some(needsExternalLimit) && options.loadExternal
      ? await options.loadExternal().catch(() => undefined)
      : undefined;

  const models: Record<string, DiscoveredModel> = {};
  const missingOutput: string[] = [];
  for (const row of included) {
    const external = catalog ? lookupLimit(catalog, row.litellm_params?.model || row.model_name) : undefined;
    if (knownOutputLimit(row.model_info, external?.output) === undefined) missingOutput.push(row.model_name);
    models[row.model_name] = assemble(row, options.apiBase, external);
  }

  if (missingOutput.length > 0) {
    console.warn(
      `[magpie-provider-litellm] 無法取得輸出上限，使用保底 ${UNKNOWN_OUTPUT_FALLBACK}：${missingOutput.join(", ")}`,
    );
  }
  return models;
}

/**
 * 探索 LiteLLM 上此金鑰可用的模型。
 * 回傳 {} 代表權威的空清單；回傳 undefined 代表兩階都不可用，呼叫端應保留既有清單。
 * @example
 * const models = await discoverModels({ rootUrl, apiBase, apiKey, loadExternal });
 * return models ?? provider.models;
 */
export async function discoverModels(options: DiscoveryOptions): Promise<Record<string, DiscoveredModel> | undefined> {
  const info = await readListing(`${options.rootUrl}/model/info`, options, fromModelInfo);
  if (info) return info.kind === "empty" ? {} : assembleAll(info.rows, options);

  const list = await readListing(`${options.apiBase}/models`, options, fromModelsList);
  if (list) return list.kind === "empty" ? {} : assembleAll(list.rows, options);

  return undefined;
}
