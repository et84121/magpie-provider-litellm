/**
 * @fileoverview magpie-provider-litellm: Magpie 原生 LiteLLM Provider 外掛
 * 遵循 Magpie Plugin 規範（相容 OpenCode v1 + Magpie 擴充 hooks），
 * 支援原生協定路由、動態模型探索、用量預算監控與雙重認證標頭補全。
 */

import { cleanUrl, getApiBase, getManagementBase, resolveModelProtocol } from "./protocol.js";
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
        label: "LiteLLM Proxy",
        prompts: [
          {
            type: "text",
            key: "baseURL",
            message: "LiteLLM Base URL (例: http://127.0.0.1:4000 或 https://litellm.internal)",
            placeholder: "http://127.0.0.1:4000",
            validate: (v: string) => {
              try {
                new URL(v.trim());
                return undefined;
              } catch {
                return "請輸入有效的 URL，例如 http://127.0.0.1:4000";
              }
            },
          },
          {
            type: "password",
            key: "apiKey",
            message: "LiteLLM API Key (Virtual Key 或 Master Key)",
            placeholder: "sk-...",
            validate: (v: string) => (v && v.trim().length > 0 ? undefined : "API Key 不得為空"),
          },
        ],
        async authorize(inputs: { baseURL: string; apiKey: string }) {
          const rootUrl = getManagementBase(inputs.baseURL);
          const apiKey = inputs.apiKey.trim();

          let accountId = cleanUrl(inputs.baseURL).replace(/^https?:\/\//, "");
          let keyName = "LiteLLM Key";

          try {
            const signal = createTimeoutSignal();
            const res = await fetch(`${rootUrl}/key/info`, {
              headers: { Authorization: `Bearer ${apiKey}` },
              signal,
            });

            if (res.ok) {
              const data = (await res.json()) as LiteLLMKeyInfoResponse;
              const info = data?.info;
              if (info) {
                keyName = info.key_name || keyName;
                accountId = info.user_id ? `${info.user_id}@${accountId}` : (info.key_name ?? accountId);
              }
            } else if (res.status === 401 || res.status === 403) {
              return { type: "failed", error: `LiteLLM 認證失敗 (HTTP ${res.status}): API Key 無效` };
            }
          } catch (err: any) {
            return { type: "failed", error: `無法連線至 LiteLLM: ${err.message}` };
          }

          return {
            type: "success",
            key: apiKey,
            metadata: {
              baseURL: cleanUrl(inputs.baseURL),
              keyName,
            },
            accountId,
          };
        },
      },
    ],

    /**
     * 每次請求的載入器：處理 BaseURL 與多協定 Header 補全
     */
    async loader(getAuth: () => Promise<MagpieStoredAuth | undefined>) {
      const auth = await getAuth();
      if (!auth) return {};

      const baseURL = getApiBase(auth.metadata?.baseURL || "http://127.0.0.1:4000");
      const apiKey = auth.key;

      return {
        baseURL,
        apiKey,
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const headers = new Headers(init?.headers);

          // 同時注入 Bearer 與 x-api-key：
          // 確保走 @ai-sdk/anthropic (/v1/messages) 與 @ai-sdk/openai-compatible (/v1/chat/completions)
          // 都能通過 LiteLLM Proxy 虛擬金鑰檢驗與上游透傳
          if (apiKey) {
            headers.set("authorization", `Bearer ${apiKey}`);
            headers.set("x-api-key", apiKey);
          }
          headers.set("x-litellm-source", "magpie");

          // 若為 Anthropic Messages 請求且缺少版本標頭，補上預設版本避免 upstream 報錯
          const urlString = input.toString();
          if (urlString.includes("/messages") && !headers.has("anthropic-version")) {
            headers.set("anthropic-version", "2023-06-01");
          }

          const res = await fetch(input, { ...init, headers });

          // 透過 X-Magpie-Sign-In 通知 Magpie Gateway：
          // 區分金鑰過期（expired 觸發換號容錯）與特定模型未部署（kept 避免停用有效帳號）
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
     * Magpie 專屬用量與預算監控（對應 magpie quota 及桌面端 Quota 卡片）
     */
    async usage(getAuth: () => Promise<MagpieStoredAuth | undefined>): Promise<MagpieUsageResponse> {
      const auth = await getAuth();
      if (!auth?.key) return { windows: [] };

      const rootUrl = getManagementBase(auth.metadata?.baseURL || "http://127.0.0.1:4000");
      try {
        const signal = createTimeoutSignal();
        const res = await fetch(`${rootUrl}/key/info`, {
          headers: { Authorization: `Bearer ${auth.key}` },
          signal,
        });

        if (!res.ok) return { plan: "LiteLLM", windows: [] };

        const data = (await res.json()) as LiteLLMKeyInfoResponse;
        const info = data?.info;
        if (!info) return { plan: "LiteLLM", windows: [] };

        const spend = typeof info.spend === "number" ? info.spend : 0;
        const maxBudget = typeof info.max_budget === "number" && info.max_budget > 0 ? info.max_budget : null;
        const resetAt = info.budget_reset_at ? new Date(info.budget_reset_at).toISOString() : undefined;

        if (maxBudget) {
          const usedPercent = Math.min(100, Math.round((spend / maxBudget) * 100));
          const remaining = Math.max(0, maxBudget - spend);
          return {
            plan: "LiteLLM Proxy",
            user: info.user_id || info.key_name || auth.accountId,
            balance: `$${remaining.toFixed(2)}`,
            windows: [
              {
                name: "Budget",
                used: usedPercent,
                amount: Number(spend.toFixed(2)),
                limit: Number(maxBudget.toFixed(2)),
                unit: "USD",
                display: `$${spend.toFixed(2)} / $${maxBudget.toFixed(2)}`,
                resetsAt: resetAt,
              },
            ],
          };
        }

        return {
          plan: "LiteLLM Proxy",
          user: info.user_id || info.key_name || auth.accountId,
          balance: `$${spend.toFixed(2)} spent`,
          windows: [],
        };
      } catch {
        return { plan: "LiteLLM", windows: [] };
      }
    },
  },

  /**
   * 5. 動態模型探索 (Model Discovery)
   */
  provider: {
    id: PROVIDER_ID,
    async models(provider: any, { auth }: { auth?: MagpieStoredAuth } = {}) {
      if (!auth?.key) return provider.models;

      const rawBase = auth.metadata?.baseURL || "http://127.0.0.1:4000";
      const rootUrl = getManagementBase(rawBase);
      const apiBase = getApiBase(rawBase);
      const headers = { Authorization: `Bearer ${auth.key}` };

      // 步驟 A: 優先向 /model/info 查詢完整 metadata
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

              // 動態決定通訊協定（Claude 走原生 Anthropic，其餘走 OpenAI-compatible）
              const protocolNpm = resolveModelProtocol(modelId, item);

              const contextLimit = info.max_input_tokens || info.max_tokens || 128000;
              const outputLimit = info.max_output_tokens || 4096;
              const hasTools = info.supports_function_calling !== false;
              const hasVision = info.supports_vision === true;
              const isReasoning =
                info.mode === "reasoning" ||
                /o1|o3|r1|deepseek-reasoner/i.test(modelId) ||
                info.supports_reasoning === true;

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
        // /model/info 失敗時退回 /v1/models
      }

      // 步驟 B: 退回標準 /v1/models (僅模型 ID 清單)
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

      // 步驟 C: 均失敗時保留既有 models，不破壞 Magpie 快取
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
