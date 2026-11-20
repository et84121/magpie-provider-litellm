/**
 * @fileoverview LiteLLM 端點位址解析與模型原生通訊協定推導工具
 */

import type { LiteLLMModelInfoEntry } from "./litellm-schema.js";
import { ModelProtocolPackage } from "./types.js";

// 模式識別正規表達式
const CLAUDE_PATTERN = /(?:^|[./_-])(?:anthropic|claude|opus|sonnet|haiku)(?:$|[./_:-])/i;
const OPENSOURCE_PATTERN =
  /(?:deepseek|kimi|moonshot|glm|zhipu|qwen|minimax|mistral|codestral|llama|nemotron|grok|yi|baichuan)/i;
const OPENAI_RESPONSES_PATTERN =
  /(?:^(?:ft:)?|[./_-])(?:gpt-[56789]|gpt-4o|gpt-4\.5|gpt-chat|o1|o3|o4|codex)(?:$|[./_:-])/i;

/**
 * 明確宣告為非 chat completions 任務的 mode（LiteLLM ModelInfoBase.mode 的子集）。
 * 只排除有明確 mode 證據的模型；未知或缺漏的 mode 仍視為對話模型，不靠名稱猜測。
 * @private
 */
const NON_CHAT_MODES = new Set([
  "embedding",
  "image_generation",
  "audio_transcription",
  "audio_speech",
  "ocr",
  "realtime",
]);

/** 名稱推論推理模型的樣式，只在沒有 supports_reasoning 證據時才用 */
const REASONING_NAME_PATTERN = /deepseek-reasoner|(?:^|[-_./])(?:o1|o3|o4|r1)(?:$|[-_./])/i;

/**
 * 清理並移除 URL 尾端多餘的斜線
 * @private
 */
export function cleanUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * 取得 LiteLLM 管理端點的根路徑（供 /key/info、/model/info、/health 使用）
 */
export function getManagementBase(url: string): string {
  const cleaned = cleanUrl(url);
  return cleaned.replace(/\/v1$/, "");
}

/**
 * 取得 LiteLLM 模型調用端點的 API 路徑（標準 /v1 結尾）
 */
export function getApiBase(url: string): string {
  const cleaned = cleanUrl(url);
  return cleaned.endsWith("/v1") ? cleaned : `${cleaned}/v1`;
}

/**
 * 解析使用者輸入之認證字串
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
 * 判斷模型是否為決策／分類評估模型（例如 Decision-1）
 */
export function isDecisionModel(modelId: string, item?: LiteLLMModelInfoEntry): boolean {
  const lowerId = modelId.toLowerCase();
  const mode = (item?.model_info?.mode || "").toLowerCase();
  const baseModel = (item?.model_info?.base_model || "").toLowerCase();

  return (
    mode === "evaluation" || mode === "decisions" || lowerId.includes("decision") || baseModel.includes("decision")
  );
}

/**
 * 判斷是否為應排除的非對話模型（如 embedding、圖片生成、語音等）。
 * 只看 model_info.mode 這個明確證據，不看模型名稱。
 */
export function isExcludedModel(modelId: string, item?: LiteLLMModelInfoEntry): boolean {
  const mode = (item?.model_info?.mode || "").toLowerCase();
  return NON_CHAT_MODES.has(mode);
}

/**
 * 判斷模型是否屬於 Claude / Anthropic 族系
 */
export function isClaudeFamily(modelId: string, item?: LiteLLMModelInfoEntry): boolean {
  const lowerId = modelId.toLowerCase();
  const provider = (
    item?.model_info?.litellm_provider ||
    item?.litellm_params?.custom_llm_provider ||
    ""
  ).toLowerCase();
  const baseModel = (item?.model_info?.base_model || "").toLowerCase();

  if (provider === "anthropic" || baseModel.includes("claude") || baseModel.includes("anthropic")) {
    return true;
  }

  return CLAUDE_PATTERN.test(lowerId);
}

/** 上游與外部目錄都查不到輸出上限時的最後保底值 */
export const UNKNOWN_OUTPUT_FALLBACK = 4096;

/** 上游與外部目錄都查不到上下文上限時的最後保底值 */
export const UNKNOWN_CONTEXT_FALLBACK = 128000;

/**
 * 大於 0 的數字才視為有效值，否則 undefined
 * @private
 */
function positiveNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

/**
 * 已知的輸出上限：上游 max_output_tokens，其次 legacy 的 max_tokens（LiteLLM 文件以之為輸出上限），
 * 最後外部目錄。三者都沒有則回傳 undefined，讓呼叫端能判斷是否用了保底。
 */
export function knownOutputLimit(
  info?: { max_output_tokens?: number | null; max_tokens?: number | null } | null,
  catalogOutput?: number,
): number | undefined {
  return positiveNumber(info?.max_output_tokens) ?? positiveNumber(info?.max_tokens) ?? positiveNumber(catalogOutput);
}

/**
 * 決定輸出上限：已知值優先，查不到才用保底。不依模型族系猜測，避免把其他模型的值誤套上去。
 */
export function resolveOutputLimit(
  info?: { max_output_tokens?: number | null; max_tokens?: number | null } | null,
  catalogOutput?: number,
): number {
  return knownOutputLimit(info, catalogOutput) ?? UNKNOWN_OUTPUT_FALLBACK;
}

/**
 * 已知的上下文上限：只看上游 max_input_tokens。不使用 max_tokens：它在 LiteLLM 的文件中是輸出上限（legacy），
 * 用來當上下文會把輸出值誤當成上下文。
 */
export function knownContextLimit(info?: { max_input_tokens?: number | null } | null): number | undefined {
  return positiveNumber(info?.max_input_tokens);
}

/**
 * 決定上下文上限：上游 max_input_tokens 優先，其次外部目錄，最後保底。
 */
export function resolveContextLimit(
  info?: { max_input_tokens?: number | null } | null,
  catalogContext?: number,
): number {
  return knownContextLimit(info) ?? positiveNumber(catalogContext) ?? UNKNOWN_CONTEXT_FALLBACK;
}

/**
 * 判斷是否支援推理：明確的 supports_reasoning 優先（包含 false），其次 mode，最後才看名稱。
 */
export function resolveReasoning(modelId: string, item?: LiteLLMModelInfoEntry): boolean {
  const explicit = item?.model_info?.supports_reasoning;
  if (typeof explicit === "boolean") return explicit;
  if ((item?.model_info?.mode || "").toLowerCase() === "reasoning") return true;
  return REASONING_NAME_PATTERN.test(modelId);
}

/**
 * 判斷模型是否屬於開源／第三方族系（DeepSeek, Qwen, Kimi, GLM, MiniMax, Llama 等）
 * 此類模型只吃標準的 /v1/chat/completions，不吃 Responses API
 */
export function isOpenSourceFamily(modelId: string, item?: LiteLLMModelInfoEntry): boolean {
  const lowerId = modelId.toLowerCase();
  const provider = (
    item?.model_info?.litellm_provider ||
    item?.litellm_params?.custom_llm_provider ||
    ""
  ).toLowerCase();
  const baseModel = (item?.model_info?.base_model || "").toLowerCase();

  return OPENSOURCE_PATTERN.test(lowerId) || OPENSOURCE_PATTERN.test(baseModel) || OPENSOURCE_PATTERN.test(provider);
}

/**
 * 判斷模型是否屬於支援原生 OpenAI Responses API（/v1/responses）的族系
 * 條件：
 * 1. 非開源系且非 Claude 系
 * 2. 符合新一代 OpenAI 命名（GPT-5+, GPT-4o, o1, o3, Codex 等），或 LiteLLM supported_endpoints 明確包含 /v1/responses
 */
export function isOpenAIResponsesFamily(modelId: string, item?: LiteLLMModelInfoEntry): boolean {
  // 開源系與 Claude 系絕不走 Responses
  if (isOpenSourceFamily(modelId, item) || isClaudeFamily(modelId, item)) {
    return false;
  }

  const endpoints = item?.model_info?.supported_endpoints;
  const listsResponses =
    Array.isArray(endpoints) && endpoints.some((e) => typeof e === "string" && e.includes("responses"));

  // 若 LiteLLM 明確宣告支援 responses 端點
  if (listsResponses) {
    return true;
  }

  // 若 supported_endpoints 明確宣告但未包含 responses（例如只列了 chat/completions），則不走 Responses
  if (Array.isArray(endpoints) && endpoints.length > 0) {
    return false;
  }

  // 若未宣告 supported_endpoints，則依據 OpenAI 新架構特徵（o1, o3, gpt-4o, gpt-5+, gpt-6+）判定
  const lowerId = modelId.toLowerCase();
  const baseModel = (item?.model_info?.base_model || "").toLowerCase();
  return OPENAI_RESPONSES_PATTERN.test(lowerId) || OPENAI_RESPONSES_PATTERN.test(baseModel);
}

/**
 * 依據模型族系與端點能力，精準指派原生通訊協定：
 * - Claude 族系 -> @ai-sdk/anthropic（/v1/messages）
 * - OpenAI 新架構（GPT-4o, o1, o3, GPT-5/6 等）-> @ai-sdk/openai（/v1/responses）
 * - 開源／第三方／傳統模型（DeepSeek, Qwen, Kimi, GLM 等）-> @ai-sdk/openai-compatible（/v1/chat/completions）
 */
export function resolveModelProtocol(modelId: string, item?: LiteLLMModelInfoEntry): ModelProtocolPackage {
  // 1. Claude 原生 Messages
  if (isClaudeFamily(modelId, item)) {
    return ModelProtocolPackage.ANTHROPIC;
  }

  // 2. 開源系強制走 Chat Completions（避免誤送 Responses）
  if (isOpenSourceFamily(modelId, item)) {
    return ModelProtocolPackage.OPENAI_COMPATIBLE;
  }

  // 3. OpenAI 新架構原生 Responses API
  if (isOpenAIResponsesFamily(modelId, item)) {
    return ModelProtocolPackage.OPENAI_RESPONSES;
  }

  // 4. 其餘預設走標準 Chat Completions
  return ModelProtocolPackage.OPENAI_COMPATIBLE;
}
