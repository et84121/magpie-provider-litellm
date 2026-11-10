/**
 * @fileoverview magpie-provider-litellm: Magpie 原生 LiteLLM Provider 外掛
 * 遵循 Magpie Plugin 規範（相容 OpenCode v1 + Magpie 擴充 hooks），
 * 支援原生協定路由、動態模型探索、用量預算監控與雙重認證標頭補全。
 */

import { queryLiteLLMBudget } from "./budget.js";
import {
  cleanUrl,
  getApiBase,
  getManagementBase,
  isDecisionModel,
  parseLoginInput,
  resolveModelProtocol,
} from "./protocol.js";
import {
  type LiteLLMKeyInfoResponse,
  type LiteLLMModelInfoEntry,
  type MagpieStoredAuth,
  type MagpieUsageResponse,
  ModelProtocolPackage,
} from "./types.js";

export const PROVIDER_ID = "litellm";
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * 建立具備逾時防護的 AbortSignal
 * @private
 */
function createTimeoutSignal(ms = DEFAULT_TIMEOUT_MS): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Magpie LiteLLM 外掛主函式
 */
export const LitellmPlugin = async () => ({
  /**
   * 宣告 Provider 基礎屬性與靜態預設模型
   */
  config: async (cfg: any) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER_ID] ??= {
      name: "LiteLLM",
      npm: ModelProtocolPackage.OPENAI_COMPATIBLE,
      api: "http://127.0.0.1:4000/v1",
      decide: true, // 宣告此 Provider 支援 System One 決策／意圖分類 API
      models: {
        "claude-3-7-sonnet": {
          name: "Claude 3.7 Sonnet (Native Messages)",
          npm: ModelProtocolPackage.ANTHROPIC,
          limit: { context: 200000, output: 64000 },
          tool_call: true,
          reasoning: true,
        },
        "gpt-4o": {
          name: "GPT-4o (Chat Completions)",
          npm: ModelProtocolPackage.OPENAI_COMPATIBLE,
          limit: { context: 128000, output: 4096 },
          tool_call: true,
        },
        "Decision-1": {
          name: "Decision-1 (Intent Classifier)",
          decides: true, // 標記為決策分類模型，供 Magpie 意圖路由使用，不對 Agent 暴露一般對話
          limit: { context: 32768, output: 4096 },
        },
      },
    };
  },

  /**
   * 帳號登入、請求攔截與額度追蹤
   */
  auth: {
    provider: PROVIDER_ID,
    methods: [
      {
        type: "api",
        label: "LiteLLM API Key",
        placeholder: "sk-...",
        prompts: [
          {
            type: "text",
            key: "baseURL",
            message: "LiteLLM Base URL",
            placeholder: "http://127.0.0.1:4000",
            validate: (v: string) => {
              if (!v || !v.trim()) return undefined; // 允許留空使用預設值
              try {
                new URL(v.trim());
                return undefined;
              } catch {
                return "請輸入有效的 URL，例如 http://127.0.0.1:4000";
              }
            },
          },
        ],
        // 不宣告 authorize 函式：
        // 依據 Magpie 規範，Magpie 會將 prompts 回答存入 metadata，
        // 並將使用者在原生輸入框填寫的密鑰存入 key ({ type: "api", key, metadata: { baseURL } })
      },
    ],

    /**
     * 每次請求的載入器：處理 BaseURL 與多協定 Header 補全
     */
    async loader(getAuth: () => Promise<MagpieStoredAuth | undefined>) {
      const auth = await getAuth();
      if (!auth) return {};

      // 若使用者在 key 欄位不小心貼上了包含 URL 的複合格式，自動解析兼顧
      let rawBase = auth.metadata?.baseURL || "http://127.0.0.1:4000";
      let apiKey = auth.key;

      if (apiKey && apiKey.includes("http")) {
        const parsed = parseLoginInput(apiKey, rawBase);
        rawBase = parsed.baseURL;
        apiKey = parsed.apiKey;
      }

      const baseURL = getApiBase(rawBase);

      return {
        baseURL,
        apiKey,
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const headers = new Headers(init?.headers);

          if (apiKey) {
            headers.set("authorization", `Bearer ${apiKey}`);
            headers.set("x-api-key", apiKey);
          }
          headers.set("x-litellm-source", "magpie");

          const urlString = input.toString();
          if (urlString.includes("/messages") && !headers.has("anthropic-version")) {
            headers.set("anthropic-version", "2023-06-01");
          }

          const res = await fetch(input, { ...init, headers });

          if (res.status === 401) {
            const clone = res.clone();
            const text = await clone.text().catch(() => "");
            const isModelSpecific = text.includes("model_not_found") || text.includes("not available");
            const newHeaders = new Headers(res.headers);
            newHeaders.set("X-Magpie-Sign-In", isModelSpecific ? "kept" : "expired");
            return new Response(res.body, {
              status: res.status,
              statusText: res.statusText,
              headers: newHeaders,
            });
          }

          return res;
        },
      };
    },

    /**
     * Magpie 專屬用量與預算監控（支援 Key -> User 多層級探索與進度視窗）
     */
    async usage(getAuth: () => Promise<MagpieStoredAuth | undefined>): Promise<MagpieUsageResponse> {
      const auth = await getAuth();
      if (!auth?.key) return { windows: [] };

      let rawBase = auth.metadata?.baseURL || "http://127.0.0.1:4000";
      let apiKey = auth.key;
      if (apiKey && apiKey.includes("http")) {
        const parsed = parseLoginInput(apiKey, rawBase);
        rawBase = parsed.baseURL;
        apiKey = parsed.apiKey;
      }

      const signal = createTimeoutSignal();
      return queryLiteLLMBudget(rawBase, apiKey, signal);
    },
  },

  /**
   * 5. 動態模型探索 (Model Discovery)
   */
  provider: {
    id: PROVIDER_ID,
    async models(provider: any, { auth }: { auth?: MagpieStoredAuth } = {}) {
      if (!auth?.key) return provider.models;

      let rawBase = auth.metadata?.baseURL || "http://127.0.0.1:4000";
      let apiKey = auth.key;
      if (apiKey && apiKey.includes("http")) {
        const parsed = parseLoginInput(apiKey, rawBase);
        rawBase = parsed.baseURL;
        apiKey = parsed.apiKey;
      }

      const rootUrl = getManagementBase(rawBase);
      const apiBase = getApiBase(rawBase);
      const headers = { Authorization: `Bearer ${apiKey}` };

      try {
        const signal = createTimeoutSignal();
        const infoRes = await fetch(`${rootUrl}/model/info`, { headers, signal });
        if (infoRes.ok) {
          const infoJson = (await infoRes.json()) as any;
          const entries: LiteLLMModelInfoEntry[] = Array.isArray(infoJson?.data) ? infoJson.data : [];
          const validEntries = entries.filter((e) => e?.model_name && !e.model_name.includes("*"));

          if (validEntries.length > 0) {
            const mapped: Record<string, any> = {};

            for (const item of validEntries) {
              const modelId = String(item.model_name);
              const info = item.model_info || {};
              const params = item.litellm_params || {};

              const isDecision = isDecisionModel(modelId, item);
              const protocolNpm = resolveModelProtocol(modelId, item);
              const contextLimit = info.max_input_tokens || info.max_tokens || 128000;
              const outputLimit = info.max_output_tokens || 4096;
              const hasTools = !isDecision && info.supports_function_calling !== false;
              const hasVision = !isDecision && info.supports_vision === true;
              const isReasoning =
                !isDecision &&
                (info.mode === "reasoning" ||
                  /o1|o3|r1|deepseek-reasoner/i.test(modelId) ||
                  info.supports_reasoning === true);

              let cost: any = undefined;
              if (typeof info.input_cost_per_token === "number" || typeof info.output_cost_per_token === "number") {
                cost = {
                  input: (info.input_cost_per_token || 0) * 1_000_000,
                  output: (info.output_cost_per_token || 0) * 1_000_000,
                };
              }

              mapped[modelId] = {
                id: modelId,
                name: modelId,
                ...(isDecision ? { decides: true } : {}),
                api: {
                  id: params.model || modelId,
                  url: apiBase,
                  npm: protocolNpm,
                },
                limit: {
                  context: contextLimit,
                  output: outputLimit,
                },
                capabilities: {
                  toolcall: hasTools,
                  reasoning: isReasoning,
                  input: {
                    text: true,
                    image: hasVision,
                  },
                },
                ...(cost ? { cost } : {}),
              };
            }

            return mapped;
          }
        }
      } catch {
        // 失敗退回 /v1/models
      }

      try {
        const signal = createTimeoutSignal();
        const listRes = await fetch(`${apiBase}/models`, { headers, signal });
        if (listRes.ok) {
          const listJson = (await listRes.json()) as any;
          const list = Array.isArray(listJson?.data) ? listJson.data : [];

          if (list.length > 0) {
            const mapped: Record<string, any> = {};
            for (const m of list) {
              const modelId = String(m.id);
              const protocolNpm = resolveModelProtocol(modelId);

              mapped[modelId] = {
                id: modelId,
                name: modelId,
                api: {
                  id: modelId,
                  url: apiBase,
                  npm: protocolNpm,
                },
                limit: {
                  context: 128000,
                  output: 4096,
                },
                capabilities: {
                  toolcall: true,
                  reasoning: /o1|o3|r1|deepseek-reasoner/i.test(modelId),
                  input: { text: true },
                },
              };
            }
            return mapped;
          }
        }
      } catch {
        // 保留原快取
      }

      return provider.models;
    },
  },

  /**
   * 6. 工作階段追蹤注入
   */
  "chat.headers": async (input: any, output: any) => {
    if (input.model?.providerID === PROVIDER_ID && input.sessionID) {
      output.headers["x-litellm-session-id"] = input.sessionID;
    }
  },
});

export default LitellmPlugin;
