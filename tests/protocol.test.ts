/**
 * @fileoverview 測試端點解析與通訊協定推導邏輯
 */

import { describe, expect, it } from "bun:test";
import {
  cleanUrl,
  DEFAULT_BASE_URL,
  getApiBase,
  getManagementBase,
  isDecisionModel,
  isExcludedModel,
  parseCompositeKey,
  resolveConnection,
  resolveModelProtocol,
  knownOutputLimit,
  resolveContextLimit,
  resolveOutputLimit,
  UNKNOWN_CONTEXT_FALLBACK,
  UNKNOWN_OUTPUT_FALLBACK,
} from "../src/protocol.js";
import { ModelProtocolPackage, type MagpieStoredAuth } from "../src/types.js";

describe("protocol / URL helpers", () => {
  it("正確清理 URL 尾端斜線", () => {
    expect(cleanUrl("http://localhost:4000/")).toBe("http://localhost:4000");
    expect(cleanUrl("https://litellm.internal///")).toBe("https://litellm.internal");
  });

  it("正確解析管理端點之根路徑", () => {
    expect(getManagementBase("http://localhost:4000/v1")).toBe("http://localhost:4000");
    expect(getManagementBase("http://localhost:4000/v1/")).toBe("http://localhost:4000");
    expect(getManagementBase("http://localhost:4000")).toBe("http://localhost:4000");
  });

  it("正確解析 API 調用端點之 /v1 路徑", () => {
    expect(getApiBase("http://localhost:4000")).toBe("http://localhost:4000/v1");
    expect(getApiBase("http://localhost:4000/v1")).toBe("http://localhost:4000/v1");
  });
});

describe("protocol / parseCompositeKey", () => {
  it("正確解析空白隔開的 URL 與 Key", () => {
    expect(parseCompositeKey("https://litellm.internal sk-123456")).toEqual({
      baseURL: "https://litellm.internal",
      apiKey: "sk-123456",
    });
  });

  it("正確解析逗號隔開的 URL 與 Key", () => {
    expect(parseCompositeKey("https://litellm.internal,sk-123456")).toEqual({
      baseURL: "https://litellm.internal",
      apiKey: "sk-123456",
    });
  });

  it("單純的 Key 不是複合格式，回傳 undefined", () => {
    expect(parseCompositeKey("sk-123456")).toBeUndefined();
  });

  it("key 中段含 http 字樣但不以 URL 開頭時，不視為複合格式", () => {
    expect(parseCompositeKey("sk-http-abc")).toBeUndefined();
  });
});

describe("protocol / resolveConnection 優先序", () => {
  /** 建立測試用的已儲存帳號（metadata.baseURL 為登入時的 Base URL 輸入） */
  const account = (key: string, baseURL?: string): MagpieStoredAuth => ({
    type: "api",
    key,
    metadata: baseURL === undefined ? undefined : { baseURL },
  });

  // 第三個參數傳空字串代表「環境變數未設定」：預設參數只在 undefined 時才讀取 process.env，測試不受外部環境影響
  it.each([
    [
      "複合 key 的 URL 勝過 metadata、環境變數與預設值",
      account("http://composite:4000 sk-x", "http://meta:4000"),
      "http://env:4000",
      "http://composite:4000",
    ],
    ["metadata 勝過環境變數", account("sk-plain", "http://meta:4000"), "http://env:4000", "http://meta:4000"],
    ["環境變數勝過預設值", account("sk-plain"), "http://env:4000", "http://env:4000"],
    ["三者皆無時使用預設值", account("sk-plain"), "", DEFAULT_BASE_URL],
    ["metadata 空白視為未設定，改用環境變數", account("sk-plain", "   "), "http://env:4000", "http://env:4000"],
    ["環境變數空白視為未設定，改用預設值", account("sk-plain", ""), "  ", DEFAULT_BASE_URL],
  ])("%s", (_name, auth, env, expected) => {
    expect(resolveConnection(auth, env).baseURL).toBe(expected);
  });

  it("沒有複合格式時 key 只去除前後空白，即使含有 http 字樣也不拆解", () => {
    expect(resolveConnection(account("  sk-http-abc  ", "http://m:4000/v1/"), "")).toEqual({
      baseURL: "http://m:4000/v1",
      apiKey: "sk-http-abc",
    });
  });
});

describe("protocol / isDecisionModel & isExcludedModel", () => {
  it("正確識別 Decision-1 及 evaluation 模式為決策分類模型", () => {
    expect(isDecisionModel("Decision-1")).toBe(true);
    expect(isDecisionModel("decision-classifier")).toBe(true);
    expect(isDecisionModel("custom-model", { model_info: { mode: "evaluation" } } as any)).toBe(true);
    expect(isDecisionModel("custom-model", { model_info: { mode: "decisions" } } as any)).toBe(true);
    expect(isDecisionModel("gpt-4o", { model_info: { mode: "chat" } } as any)).toBe(false);
  });

  it("正確識別 embedding 與 image_generation 模型為排除對象", () => {
    expect(isExcludedModel("text-embedding-3-small", { model_info: { mode: "embedding" } } as any)).toBe(true);
    expect(isExcludedModel("gpt-image-2", { model_info: { mode: "image_generation" } } as any)).toBe(true);
    expect(isExcludedModel("deepseek-chat", { model_info: { mode: "chat" } } as any)).toBe(false);
  });
});

describe("protocol / resolveModelProtocol (三位一體協定劃分)", () => {
  it("Claude 族系走 Anthropic Messages 協定 (/v1/messages)", () => {
    expect(resolveModelProtocol("claude-3-7-sonnet")).toBe(ModelProtocolPackage.ANTHROPIC);
    expect(resolveModelProtocol("claude-3-5-haiku-20241022")).toBe(ModelProtocolPackage.ANTHROPIC);
    expect(resolveModelProtocol("my-sonnet")).toBe(ModelProtocolPackage.ANTHROPIC);
    expect(resolveModelProtocol("opus-latest")).toBe(ModelProtocolPackage.ANTHROPIC);

    const item = { model_info: { litellm_provider: "anthropic" } };
    expect(resolveModelProtocol("custom-routed-model", item as any)).toBe(ModelProtocolPackage.ANTHROPIC);
  });

  it("OpenAI 新架構模型走原生 Responses 協定 (/v1/responses)", () => {
    expect(resolveModelProtocol("gpt-4o")).toBe(ModelProtocolPackage.OPENAI_RESPONSES);
    expect(resolveModelProtocol("gpt-4o-mini")).toBe(ModelProtocolPackage.OPENAI_RESPONSES);
    expect(resolveModelProtocol("o1")).toBe(ModelProtocolPackage.OPENAI_RESPONSES);
    expect(resolveModelProtocol("o1-mini")).toBe(ModelProtocolPackage.OPENAI_RESPONSES);
    expect(resolveModelProtocol("o3-mini")).toBe(ModelProtocolPackage.OPENAI_RESPONSES);
    expect(resolveModelProtocol("gpt-5.6-sol")).toBe(ModelProtocolPackage.OPENAI_RESPONSES);
    expect(resolveModelProtocol("gpt-6-luna")).toBe(ModelProtocolPackage.OPENAI_RESPONSES);
    expect(resolveModelProtocol("gpt-chat-latest")).toBe(ModelProtocolPackage.OPENAI_RESPONSES);

    // 透過 supported_endpoints 明確包含 responses
    const itemWithResponses = {
      model_info: { supported_endpoints: ["/v1/chat/completions", "/v1/responses"] },
    };
    expect(resolveModelProtocol("custom-azure-gpt", itemWithResponses as any)).toBe(
      ModelProtocolPackage.OPENAI_RESPONSES,
    );
  });

  it("開源系與第三方模型強制走 Chat Completions 協定 (/v1/chat/completions)", () => {
    expect(resolveModelProtocol("deepseek-v4-pro")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("DeepSeek-V4.1-Flash-1017")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("kimi-k2.6")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("Kimi-K3.1-Pro")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("GLM-5.3")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("GLM-5.3-Flash")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("qwen-2.5-coder")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("MiniMax-M3")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("Nemotron-Lightning-3.5-30B-A3B")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("grok-4.7")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("llama-3.3-70b")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);

    // 傳統舊版 OpenAI 模型走 Chat Completions
    expect(resolveModelProtocol("gpt-3.5-turbo")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("gpt-4")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
  });
});

describe("protocol / output limit", () => {
  it("上游有回報 max_output_tokens 時直接採用", () => {
    expect(resolveOutputLimit({ max_output_tokens: 128000 })).toBe(128000);
  });

  it("上游沒回報時採用外部目錄值", () => {
    expect(resolveOutputLimit({ max_output_tokens: null }, 128000)).toBe(128000);
  });

  it("上游與目錄都沒有時退回保底 4096，不依模型族系猜測", () => {
    expect(resolveOutputLimit({}, undefined)).toBe(4096);
    expect(resolveOutputLimit({ max_output_tokens: null })).toBe(UNKNOWN_OUTPUT_FALLBACK);
  });

  it("max_tokens 是上游第二順位來源，優先於外部目錄", () => {
    expect(resolveOutputLimit({ max_output_tokens: null, max_tokens: 16384 }, 128000)).toBe(16384);
  });

  it("knownOutputLimit 只在確實有值時回傳，供呼叫端判斷是否落到保底", () => {
    expect(knownOutputLimit({})).toBeUndefined();
    expect(knownOutputLimit({ max_output_tokens: 0 }, 0)).toBeUndefined();
    expect(knownOutputLimit({ max_tokens: 16384 })).toBe(16384);
    expect(knownOutputLimit({}, 65536)).toBe(65536);
  });
});

describe("protocol / context limit", () => {
  it("上游 max_input_tokens 優先", () => {
    expect(resolveContextLimit({ max_input_tokens: 200000 }, 1000000)).toBe(200000);
  });

  it("不使用 max_tokens 當上下文：它是輸出上限，不能誤當成 context", () => {
    // max_tokens 是 legacy 的輸出欄位；若誤用，上下文會被縮成輸出上限
    expect(resolveContextLimit({ max_tokens: 16384 } as any)).toBe(UNKNOWN_CONTEXT_FALLBACK);
    expect(resolveContextLimit({ max_tokens: 16384 } as any, 200000)).toBe(200000);
  });

  it("上游沒有時採用外部目錄，都沒有則用集中定義的保底值", () => {
    expect(resolveContextLimit({ max_input_tokens: null }, 1000000)).toBe(1000000);
    expect(resolveContextLimit({})).toBe(128000);
    expect(UNKNOWN_CONTEXT_FALLBACK).toBe(128000);
  });
});
