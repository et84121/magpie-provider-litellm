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
 * 判斷模型是否屬於 Claude / Anthropic 族系
 * 依據 LiteLLM 提供的 provider 或 base_model，以及模型名稱關鍵字綜合研判
 * @private
 */
export function isClaudeFamily(modelId: string, item?: LiteLLMModelInfoEntry): boolean {
  const lowerId = modelId.toLowerCase();
  const provider = (item?.model_info?.litellm_provider || item?.litellm_params?.custom_llm_provider || "").toLowerCase();
  const baseModel = (item?.model_info?.base_model || "").toLowerCase();

  // 若 LiteLLM 明確標示後端供應商為 anthropic，或 base_model 具備 claude 特徵
  if (provider === "anthropic" || baseModel.includes("claude") || baseModel.includes("anthropic")) {
    return true;
  }

  // 若無 metadata，則依據公開命名慣例（claude-3-5, sonnet, haiku, opus）識別
  return /(?:^|[./_-])(?:anthropic|claude|opus|sonnet|haiku)(?:$|[./_:-])/i.test(lowerId);
}

/**
 * 依據模型名稱與 LiteLLM 後端資訊，決定應發配的原生通訊協定
 *
 * 設計考量：
 * 讓 Claude 系列模型直走 @ai-sdk/anthropic（對應 /v1/messages），
 * 能避免 Magpie Gateway 將 Anthropic Messages 轉為 OpenAI Chat 格式、
 * LiteLLM 再轉回 Anthropic 的雙重轉譯損耗，完整保留 Extended Thinking 與 Tool Use 簽名；
 * 其餘開源或通用模型則走標準 @ai-sdk/openai-compatible（對應 /v1/chat/completions）。
 */
export function resolveModelProtocol(modelId: string, item?: LiteLLMModelInfoEntry): ModelProtocolPackage {
  if (isClaudeFamily(modelId, item)) {
    return ModelProtocolPackage.ANTHROPIC;
  }

  return ModelProtocolPackage.OPENAI_COMPATIBLE;
}
