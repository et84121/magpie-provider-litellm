/**
 * @fileoverview 模型上限（context / output）查詢。
 * LiteLLM /model/info 對部分模型（如 azure_ai 上的 Claude 5）不回報上限，
 * 此時改查 models.dev 公開目錄，並在本機快取，避免每次啟動都下載。
 */

export const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 下載 models.dev 的逾時，避免連線黑洞時卡住模型探索 */
const DOWNLOAD_TIMEOUT_MS = 10_000;

export interface ModelLimit {
  context: number;
  output: number;
}

/** models.dev 目錄形狀：provider -> models -> limit */
export type ModelsDevCatalog = Record<
  string,
  { models?: Record<string, { limit?: { context?: number; output?: number } }> }
>;

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
  const official = ["anthropic", "azure", "zhipuai", "moonshotai"];
  const providers = [...new Set([...preferred, ...official])];

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
    if (limit?.context && limit?.output) return { context: limit.context, output: limit.output };
  }
  return undefined;
}

/**
 * 下載目錄；失敗（網路、逾時、非 2xx、非 JSON）回傳 undefined
 * @private
 */
async function download(
  fetcher: (url: string, signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
): Promise<ModelsDevCatalog | undefined> {
  try {
    const res = await fetcher(MODELS_DEV_URL, AbortSignal.timeout(timeoutMs));
    if (!res.ok) return undefined;
    return (await res.json()) as ModelsDevCatalog;
  } catch {
    return undefined;
  }
}

/**
 * 取得目錄：快取未過期直接讀，否則下載並寫回。下載失敗時退回舊快取（可能為 undefined）。
 * 快取寫入失敗（唯讀目錄、磁碟滿）不影響本次已下載成功的結果。
 */
export async function loadCatalog(
  cachePath: string,
  fetcher: (url: string, signal: AbortSignal) => Promise<Response> = (url, signal) => fetch(url, { signal }),
  now: () => number = Date.now,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<ModelsDevCatalog | undefined> {
  const file = Bun.file(cachePath);
  const cached = (await file.exists()) ? await file.json().catch(() => undefined) : undefined;
  const fresh = cached && typeof cached.fetchedAt === "number" && now() - cached.fetchedAt < CACHE_TTL_MS;
  if (fresh) return cached.catalog;

  const catalog = await download(fetcher, timeoutMs);
  if (!catalog) return cached?.catalog;

  await Bun.write(cachePath, JSON.stringify({ fetchedAt: now(), catalog })).catch(() => undefined);
  return catalog;
}
