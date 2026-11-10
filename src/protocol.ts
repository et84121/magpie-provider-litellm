/**
 * @fileoverview LiteLLM 端點位址解析與模型原生通訊協定推導工具
 */

import { type LiteLLMModelInfoEntry, ModelProtocolPackage } from "./types.js";

/**
 * 清理並移除 URL 尾端多餘的斜線
 * @private
 */
export function cleanUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * 取得 LiteLLM 管理端點的根路徑（供 /key/info、/model/info、/health 使用）
 * @example
 * getManagementBase("http://localhost:4000/v1") // returns "http://localhost:4000"
 */
export function getManagementBase(url: string): string {
  const cleaned = cleanUrl(url);
  return cleaned.replace(/\/v1$/, "");
}

/**
 * 取得 LiteLLM 模型調用端點的 API 路徑（標準 /v1 結尾）
 * 供 Magpie Gateway 發送 /messages 或 /chat/completions 使用
 * @example
 * getApiBase("http://localhost:4000") // returns "http://localhost:4000/v1"
 */
export function getApiBase(url: string): string {
  const cleaned = cleanUrl(url);
  return cleaned.endsWith("/v1") ? cleaned : `${cleaned}/v1`;
}

/**
 * 解析使用者輸入之認證字串
 *
 * 支援以下兩種情境：
 * 1. 複合格式（同時帶網址與金鑰）："https://litellm.internal sk-..." 或 "https://litellm.internal,sk-..."
 * 2. 純金鑰格式：若只輸入 "sk-..."，則回退使用環境變數 LITELLM_BASE_URL 或本機預設 http://127.0.0.1:4000
 */
export function parseLoginInput(
  raw: string,
  defaultBase = "http://127.0.0.1:4000",
): { baseURL: string; apiKey: string } {
  const text = raw.trim();
  const splitMatch = text.match(/^(https?:\/\/[^\s,#|]+)[\s,#|]+(.+)$/i);

  if (splitMatch) {
    return {
      baseURL: cleanUrl(splitMatch[1]),
      apiKey: splitMatch[2].trim(),
    };
  }

  const envBase = typeof process !== "undefined" ? process.env?.LITELLM_BASE_URL : undefined;
  return {
    baseURL: cleanUrl(envBase || defaultBase),
    apiKey: text,
  };
}

/**
 * 判斷模型是否屬於 Claude / Anthropic 族系
 * 依據 LiteLLM 提供的 provider 或 base_model，以及模型名稱關鍵字綜合研判
 * @private
 */
export function isClaudeFamily(modelId: string, item?: LiteLLMModelInfoEntry): boolean {
  const lowerId = modelId.toLowerCase();
  const provider = (item?.model_info?.litellm_provider || item?.litellm_params?.custom_llm_provider || "").toLowerCase();
  const baseModel = (item?.model_info?.base_model || "").toLowerCase();

  if (provider === "anthropic" || baseModel.includes("claude") || baseModel.includes("anthropic")) {
    return true;
  }

  return /(?:^|[./_-])(?:anthropic|claude|opus|sonnet|haiku)(?:$|[./_:-])/i.test(lowerId);
}

/**
 * 判斷模型是否為決策／分類評估模型（例如 Decision-1、mode 為 evaluation 或 decisions）
 * 此類模型對應 Magpie System One 規範，專供意圖路由與分類器使用，不可作為一般聊天對話模型
 */
export function isDecisionModel(modelId: string, item?: LiteLLMModelInfoEntry): boolean {
  const lowerId = modelId.toLowerCase();
  const mode = (item?.model_info?.mode || "").toLowerCase();
  const baseModel = (item?.model_info?.base_model || "").toLowerCase();

  return (
    mode === "evaluation" ||
    mode === "decisions" ||
    lowerId.includes("decision") ||
    baseModel.includes("decision")
  );
}

/**
 * 依據模型名稱與 LiteLLM 後端資訊，決定應發配的原生通訊協定
 */
export function resolveModelProtocol(modelId: string, item?: LiteLLMModelInfoEntry): ModelProtocolPackage {
  if (isClaudeFamily(modelId, item)) {
    return ModelProtocolPackage.ANTHROPIC;
  }

  return ModelProtocolPackage.OPENAI_COMPATIBLE;
}
