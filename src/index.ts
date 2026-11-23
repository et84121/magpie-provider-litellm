/**
 * @fileoverview magpie-provider-litellm: Magpie 原生 LiteLLM Provider 外掛
 * 遵循 Magpie Plugin 規範（相容 OpenCode v1 + Magpie 擴充 hooks），
 * 支援原生協定路由、動態模型探索、用量預算監控與雙重認證標頭補全。
 */

import { copyHeadersWithoutStaleBody, readBoundedText } from "./bounded-body.js";
import { queryLiteLLMBudget } from "./budget.js";
import { discoverModels } from "./discovery.js";
import { loadCatalog } from "./limits.js";
import { getApiBase, getManagementBase, resolveConnection } from "./protocol.js";
import { enrichRateLimitResponse } from "./rate-limit.js";
import { classifyUnauthorized, SIGN_IN_HEADER, signInStateFor } from "./sign-in.js";
import { type MagpieStoredAuth, type MagpieUsageResponse, ModelProtocolPackage, REQUEST_TIMEOUT_MS } from "./types.js";

export const PROVIDER_ID = "litellm";
const CATALOG_CACHE_PATH = `${process.env.HOME ?? "."}/.cache/magpie-provider-litellm/models-dev.json`;

/**
 * 取出請求的 URL 字串，支援 Request、URL 與字串三種輸入
 * @private
 */
function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

/**
 * 判斷 URL 的路徑是否含 messages 片段（/v1/messages、/v1/messages/count_tokens），以路徑段比對而非子字串。
 * 無法解析的 URL 視為非 Messages 端點。
 * @private
 */
function isAnthropicMessagesUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return pathname.split("/").includes("messages");
}

/**
 * 為 401 回應加上 X-Magpie-Sign-In：只有確認的 key 失效才標 expired，其餘 kept，避免健康帳號被誤標。
 * 內文只做有界讀取，原回應 body 保持可讀，回傳的 Response 內容與狀態不變。
 * @private
 */
async function withSignInState(res: Response): Promise<Response> {
  const state = signInStateFor(classifyUnauthorized(await readBoundedText(res)));
  const headers = copyHeadersWithoutStaleBody(res.headers);
  headers.set(SIGN_IN_HEADER, state);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
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
      // Magpie 只在供應商啟用決策 API 時採用模型的 decides 標記。
      decide: true,
      models: {
        "claude-3-7-sonnet": {
          name: "Claude 3.7 Sonnet (Native Messages)",
          provider: { npm: ModelProtocolPackage.ANTHROPIC, api: "http://127.0.0.1:4000/v1" },
          limit: { context: 200000, output: 64000 },
          tool_call: true,
          reasoning: true,
        },
        "gpt-4o": {
          name: "GPT-4o (OpenAI Responses)",
          provider: { npm: ModelProtocolPackage.OPENAI_RESPONSES, api: "http://127.0.0.1:4000/v1" },
          limit: { context: 128000, output: 4096 },
          tool_call: true,
        },
        "deepseek-chat": {
          name: "DeepSeek Chat (Chat Completions)",
          provider: { npm: ModelProtocolPackage.OPENAI_COMPATIBLE, api: "http://127.0.0.1:4000/v1" },
          limit: { context: 128000, output: 8192 },
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
          // Request 的標頭先保留，init 的標頭疊在上面，再補上認證與來源標頭
          const headers = new Headers(input instanceof Request ? input.headers : undefined);
          new Headers(init?.headers).forEach((value, name) => headers.set(name, value));

          if (apiKey) {
            headers.set("authorization", `Bearer ${apiKey}`);
            headers.set("x-api-key", apiKey);
          }
          headers.set("x-litellm-source", "magpie");

          if (isAnthropicMessagesUrl(requestUrl(input)) && !headers.has("anthropic-version")) {
            headers.set("anthropic-version", "2023-06-01");
          }

          const res = await fetch(input, { ...init, headers });
          if (res.status === 401) return withSignInState(res);
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
      return queryLiteLLMBudget(baseURL, apiKey, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
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
