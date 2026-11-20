/**
 * @fileoverview magpie-provider-litellm: Magpie 原生 LiteLLM Provider 外掛
 * 遵循 Magpie Plugin 規範（相容 OpenCode v1 + Magpie 擴充 hooks），
 * 支援原生協定路由、動態模型探索、用量預算監控與雙重認證標頭補全。
 */

import { queryLiteLLMBudget } from "./budget.js";
import { discoverModels } from "./discovery.js";
import { loadCatalog } from "./limits.js";
import { getApiBase, getManagementBase, resolveConnection } from "./protocol.js";
import { enrichRateLimitResponse } from "./rate-limit.js";
import { createTimeoutSignal } from "./timeout.js";
import { type MagpieStoredAuth, type MagpieUsageResponse, ModelProtocolPackage } from "./types.js";

export const PROVIDER_ID = "litellm";
const CATALOG_CACHE_PATH = `${process.env.HOME ?? "."}/.cache/magpie-provider-litellm/models-dev.json`;
const DEFAULT_TIMEOUT_MS = 10000;

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
          name: "GPT-4o (OpenAI Responses)",
          npm: ModelProtocolPackage.OPENAI_RESPONSES,
          limit: { context: 128000, output: 4096 },
          tool_call: true,
        },
        "deepseek-chat": {
          name: "DeepSeek Chat (Chat Completions)",
          npm: ModelProtocolPackage.OPENAI_COMPATIBLE,
          limit: { context: 128000, output: 8192 },
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

      const connection = resolveConnection(auth);
      const apiKey = connection.apiKey;

      return {
        baseURL: getApiBase(connection.baseURL),
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

          return enrichRateLimitResponse(res);
        },
      };
    },

    /**
     * Magpie 專屬用量與預算監控（支援 Key -> User 多層級探索與進度視窗）
     */
    async usage(getAuth: () => Promise<MagpieStoredAuth | undefined>): Promise<MagpieUsageResponse> {
      const auth = await getAuth();
      if (!auth?.key) return { windows: [] };

      const { baseURL, apiKey } = resolveConnection(auth);
      const timeout = createTimeoutSignal(DEFAULT_TIMEOUT_MS);
      try {
        return await queryLiteLLMBudget(baseURL, apiKey, timeout.signal);
      } finally {
        timeout.dispose();
      }
    },
  },

  /**
   * 5. 動態模型探索 (Model Discovery)：/model/info → /v1/models 階梯與組裝見 discovery.ts
   */
  provider: {
    id: PROVIDER_ID,
    async models(provider: any, { auth }: { auth?: MagpieStoredAuth } = {}) {
      if (!auth?.key) return provider.models;

      const { baseURL, apiKey } = resolveConnection(auth);
      const discovered = await discoverModels({
        rootUrl: getManagementBase(baseURL),
        apiBase: getApiBase(baseURL),
        apiKey,
        loadExternal: () => loadCatalog(CATALOG_CACHE_PATH),
      });
      // 兩階都不可用（傳輸失敗、損毀回應）時保留 Magpie 既有的清單
      return discovered ?? provider.models;
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
