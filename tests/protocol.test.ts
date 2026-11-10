/**
 * @fileoverview 測試端點解析與通訊協定推導邏輯
 */

import { describe, expect, it } from "bun:test";
import { cleanUrl, getApiBase, getManagementBase, isClaudeFamily, resolveModelProtocol } from "../src/protocol.js";
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

describe("protocol / resolveModelProtocol", () => {
  it("識別 Claude 系列模型走 Anthropic Messages 協定", () => {
    expect(resolveModelProtocol("claude-3-7-sonnet")).toBe(ModelProtocolPackage.ANTHROPIC);
    expect(resolveModelProtocol("claude-3-5-haiku-20241022")).toBe(ModelProtocolPackage.ANTHROPIC);
    expect(resolveModelProtocol("my-sonnet")).toBe(ModelProtocolPackage.ANTHROPIC);
    expect(resolveModelProtocol("opus-latest")).toBe(ModelProtocolPackage.ANTHROPIC);

    // 透過 LiteLLM metadata 識別
    const itemWithProvider = {
      model_info: { litellm_provider: "anthropic" },
    };
    expect(resolveModelProtocol("custom-routed-model", itemWithProvider as any)).toBe(
      ModelProtocolPackage.ANTHROPIC,
    );
  });

  it("識別非 Claude 模型走 OpenAI-compatible Chat Completions 協定", () => {
    expect(resolveModelProtocol("deepseek-chat")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("gpt-4o")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("qwen-2.5-coder")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
    expect(resolveModelProtocol("moonshot-v1-auto")).toBe(ModelProtocolPackage.OPENAI_COMPATIBLE);
  });
});
