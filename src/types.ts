/**
 * @fileoverview 定義 Magpie Plugin 與 LiteLLM API 之型別結構
 * 規格出處：
 * - Magpie Plugin: https://usemagpie.ai/docs/plugins
 * - LiteLLM Model Info: https://docs.litellm.ai/docs/proxy/model_management#model-info
 * - LiteLLM Key Info: https://docs.litellm.ai/docs/proxy/users_and_keys#key-information
 */

/** 與 LiteLLM / models.dev 通訊的預設 HTTP 逾時（毫秒） */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 支援的模型通訊協定套件標記
 */
export enum ModelProtocolPackage {
  ANTHROPIC = "@ai-sdk/anthropic",
  OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible",
  OPENAI_RESPONSES = "@ai-sdk/openai",
}

export type { LiteLLMModelInfoEntry } from "./litellm-schema.js";

/**
 * Magpie 帳號認證儲存中繼資料
 */
export interface MagpieAuthMetadata {
  baseURL: string;
  keyName?: string;
  userId?: string;
}

/**
 * Magpie 帳號儲存結構
 */
export interface MagpieStoredAuth {
  type: string;
  key: string;
  accountId?: string;
  metadata?: MagpieAuthMetadata;
}

/**
 * Magpie 用量進度視窗
 */
export interface MagpieUsageWindow {
  name: string;
  used?: number;
  amount?: number;
  limit?: number;
  unit?: string;
  display?: string;
  resetsAt?: string;
  /** 視窗涵蓋的秒數（週期長度），供 Magpie 計算進度 */
  span?: number;
  /** true 代表僅作展示：用完不會擋請求，Magpie routing 不讀取 */
  aside?: boolean;
}

/**
 * Magpie 用量回傳結構
 */
export interface MagpieUsageResponse {
  plan?: string;
  user?: string;
  balance?: string;
  error?: string;
  windows: MagpieUsageWindow[];
}
