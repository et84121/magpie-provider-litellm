/**
 * @fileoverview 模型上限（context / output）查詢。
 * LiteLLM /model/info 對部分模型（如 azure_ai 上的 Claude 5）不回報上限，
 * 此時改查 models.dev 公開目錄，並在本機快取，避免每次探索都下載。
 * 規格出處：https://models.dev/api.json（provider -> models -> limit: { context, output }）
 * 只保留查表用到的投影（官方來源 provider 下、上限完整的條目），不鏡像整份 API。
 */

import { z } from "zod";
import { REQUEST_TIMEOUT_MS } from "./types.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 下載 models.dev 的逾時，避免連線黑洞時卡住模型探索 */
const DOWNLOAD_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

/** 只採用這些官方來源，不掃描全目錄（避免同名模型取到他家的值）；順序即查詢優先序 */
const OFFICIAL_PROVIDERS = ["anthropic", "azure", "zhipuai", "moonshotai"];

const LimitSchema = z.object({
  context: z.number().int().positive(),
  output: z.number().int().positive(),
});

/** 投影後的目錄形狀：provider -> models -> limit，上限皆為正整數 */
export const ModelsDevCatalogSchema = z.record(
  z.string(),
  z.object({ models: z.record(z.string(), z.object({ limit: LimitSchema })) }),
);
export type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;

/** 快取檔信封：下載時間與投影後的目錄 */
const CacheEnvelopeSchema = z.object({
  fetchedAt: z.number().int().nonnegative(),
  catalog: z.unknown(),
});

export interface ModelLimit {
  context: number;
  output: number;
}

/**
 * 從 LiteLLM 的 litellm_params.model（如 "azure_ai/claude-sonnet-5-5"）
 * 推導出 models.dev 的候選 (provider, modelId) 組合。
 * 依序嘗試，第一個命中即採用。
 */
export function candidateLookups(litellmModel: string): Array<{ provider: string; id: string }> {
  const slash = litellmModel.indexOf("/");
  const route = slash >= 0 ? litellmModel.slice(0, slash) : "";
  const raw = slash >= 0 ? litellmModel.slice(slash + 1) : litellmModel;
  // 去掉 vendor 前綴（如 Foundry 的 FW-GLM-5.3 -> GLM-5.3），再依大小寫不敏感比對
  const bare = raw.replace(/^FW-/i, "");
  const ids = [...new Set([raw, bare].map((x) => x.toLowerCase()))];

  // 依路由決定優先 provider，其後是官方來源（不做全目錄掃描，避免同名模型取到他家的值）
  const preferred = route === "azure_ai" || route === "azure" ? ["azure"] : [];
  const providers = [...new Set([...preferred, ...OFFICIAL_PROVIDERS])];

  const out: Array<{ provider: string; id: string }> = [];
  for (const provider of providers) for (const id of ids) out.push({ provider, id });
  return out;
}

/** 在目錄中查上限；查不到回傳 undefined */
export function lookupLimit(catalog: ModelsDevCatalog, litellmModel: string): ModelLimit | undefined {
  for (const { provider, id } of candidateLookups(litellmModel)) {
    const models = catalog[provider]?.models ?? {};
    const key = Object.keys(models).find((k) => k.toLowerCase() === id);
    const limit = key ? models[key]?.limit : undefined;
    if (limit) return { context: limit.context, output: limit.output };
  }
  return undefined;
}

/**
 * 把 models.dev 原始 JSON 投影成查表所需的最小形狀。
 * 單一條目不合格只略過該條目；整體沒有任何可用條目時回傳 undefined（視為不可用的下載）。
 * @private
 */
function projectCatalog(raw: unknown): ModelsDevCatalog | undefined {
  const providers = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!providers.success) return undefined;

  const out: ModelsDevCatalog = {};
  for (const provider of OFFICIAL_PROVIDERS) {
    const scoped = z.object({ models: z.record(z.string(), z.unknown()) }).safeParse(providers.data[provider]);
    if (!scoped.success) continue;

    const kept: ModelsDevCatalog[string]["models"] = {};
    for (const [id, entry] of Object.entries(scoped.data.models)) {
      const parsed = z.object({ limit: LimitSchema }).safeParse(entry);
      if (parsed.success) kept[id] = parsed.data;
    }
    if (Object.keys(kept).length > 0) out[provider] = { models: kept };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 下載目錄；失敗（網路、逾時、非 2xx、非 JSON、形狀不合）回傳 undefined
 * @private
 */
async function download(
  fetcher: (url: string, signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
): Promise<ModelsDevCatalog | undefined> {
  try {
    const res = await fetcher(MODELS_DEV_URL, AbortSignal.timeout(timeoutMs));
    if (!res.ok) return undefined;
    return projectCatalog(await res.json());
  } catch {
    return undefined;
  }
}

/**
 * 讀取快取信封並投影目錄。舊版快取是完整的 models.dev 副本，這裡用與下載相同的寬鬆投影讀取，
 * 讓其中可用的條目仍可使用；檔案不存在、非 JSON、信封不合或投影後沒有任何條目都視為沒有快取。
 * @private
 */
async function readCache(cachePath: string): Promise<{ fetchedAt: number; catalog: ModelsDevCatalog } | undefined> {
  try {
    const parsed = CacheEnvelopeSchema.safeParse(await Bun.file(cachePath).json());
    if (!parsed.success) return undefined;
    const catalog = projectCatalog(parsed.data.catalog);
    return catalog ? { fetchedAt: parsed.data.fetchedAt, catalog } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 快取是否仍在 TTL 內；時間戳在未來（時鐘倒退）視為不新鮮，改為重新下載
 * @private
 */
function isFresh(fetchedAt: number, nowMs: number): boolean {
  const age = nowMs - fetchedAt;
  return age >= 0 && age < CACHE_TTL_MS;
}

/**
 * 取得目錄：快取未過期且形狀合法直接讀；否則下載並寫回投影後的目錄。
 * 快取形狀不合（新鮮但損毀）會重新下載；下載失敗或內容不合時保留既有有效快取（可能已過期），不覆寫。
 * 快取寫入失敗（唯讀目錄、磁碟滿）不影響本次已下載成功的結果。
 */
export async function loadCatalog(
  cachePath: string,
  fetcher: (url: string, signal: AbortSignal) => Promise<Response> = (url, signal) => fetch(url, { signal }),
  now: () => number = Date.now,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<ModelsDevCatalog | undefined> {
  const cached = await readCache(cachePath);
  if (cached && isFresh(cached.fetchedAt, now())) return cached.catalog;

  const catalog = await download(fetcher, timeoutMs);
  if (!catalog) return cached?.catalog;

  await Bun.write(cachePath, JSON.stringify({ fetchedAt: now(), catalog })).catch(() => undefined);
  return catalog;
}
