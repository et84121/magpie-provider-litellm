/**
 * @fileoverview 測試端點解析與通訊協定推導邏輯
 */

import { describe, expect, it } from "bun:test";
import {
  cleanUrl,
  getApiBase,
  getManagementBase,
  isClaudeFamily,
  isDecisionModel,
  isExcludedModel,
  isOpenAIResponsesFamily,
  isOpenSourceFamily,
  parseLoginInput,
  resolveModelProtocol,
} from "../src/protocol.js";
import { ModelProtocolPackage } from "../src/types.js";

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

describe("protocol / parseLoginInput", () => {
  it("正確解析空白隔開的 URL 與 Key", () => {
    const res = parseLoginInput("https://litellm.internal sk-123456");
    expect(res.baseURL).toBe("https://litellm.internal");
    expect(res.apiKey).toBe("sk-123456");
  });

  it("正確解析逗號隔開的 URL 與 Key", () => {
    const res = parseLoginInput("https://litellm.internal,sk-123456");
    expect(res.baseURL).toBe("https://litellm.internal");
    expect(res.apiKey).toBe("sk-123456");
  });

  it("只輸入 Key 時使用預設 Base URL", () => {
    const res = parseLoginInput("sk-123456");
    expect(res.baseURL).toBe("http://127.0.0.1:4000");
    expect(res.apiKey).toBe("sk-123456");
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
