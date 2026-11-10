/**
 * @fileoverview 定義 Magpie Plugin 與 LiteLLM API 之型別結構
 * 規格出處：
 * - Magpie Plugin: https://usemagpie.ai/docs/plugins
 * - LiteLLM Model Info: https://docs.litellm.ai/docs/proxy/model_management#model-info
 * - LiteLLM Key Info: https://docs.litellm.ai/docs/proxy/users_and_keys#key-information
 */

/**
 * 支援的模型通訊協定套件標記
 */
export enum ModelProtocolPackage {
  ANTHROPIC = "@ai-sdk/anthropic",
  OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible",
  OPENAI_RESPONSES = "@ai-sdk/openai",
}

/**
 * LiteLLM /model/info 回傳項目
 * 規格出處：https://docs.litellm.ai/docs/proxy/model_management
 */
export interface LiteLLMModelInfoEntry {
  model_name?: string;
  litellm_params?: {
    model?: string;
    custom_llm_provider?: string;
    api_base?: string;
  };
  model_info?: {
    base_model?: string;
    litellm_provider?: string;
    mode?: string;
    max_tokens?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
    input_cost_per_token?: number;
    output_cost_per_token?: number;
    supports_function_calling?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
  };
}

/**
 * LiteLLM /key/info 回傳結構
 * 規格出處：https://docs.litellm.ai/docs/proxy/users_and_keys
 */
export interface LiteLLMKeyInfoResponse {
  key?: string;
  info?: {
    key_name?: string;
    user_id?: string;
    team_id?: string;
    spend?: number;
    max_budget?: number;
    budget_reset_at?: string;
    models?: string[];
  };
}

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
