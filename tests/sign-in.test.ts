/**
 * @fileoverview 測試 401 三種判定結果與 X-Magpie-Sign-In 對應：只有確認的 key 失效才會標記 expired
 */

import { describe, expect, it } from "bun:test";
import { classifyUnauthorized, SignInState, signInStateFor, UnauthorizedOutcome } from "../src/sign-in.js";

describe("classifyUnauthorized / 確認的 key 失效", () => {
  it("OpenAI 路由的 expired_key 類型判定為 key 失效", () => {
    const text = JSON.stringify({ error: { message: "Expired key", type: "expired_key" } });
    expect(classifyUnauthorized(text)).toBe(UnauthorizedOutcome.KEY_FAILURE);
  });

  it("Anthropic 路由的 litellm_error_type 也會被看見", () => {
    const text = JSON.stringify({ error: { message: "token missing", litellm_error_type: "token_not_found_in_db" } });
    expect(classifyUnauthorized(text)).toBe(UnauthorizedOutcome.KEY_FAILURE);
  });

  it("閘道回報 token 無效的文字判定為 key 失效", () => {
    const text = JSON.stringify({
      error: { message: "Authentication Error, Invalid proxy server token passed.", type: "authentication_error" },
    });
    expect(classifyUnauthorized(text)).toBe(UnauthorizedOutcome.KEY_FAILURE);
  });

  it("同時提到模型與 token 無效時仍判定為 key 失效", () => {
    const text = JSON.stringify({ error: "model gpt-x not available; the token is invalid" });
    expect(classifyUnauthorized(text)).toBe(UnauthorizedOutcome.KEY_FAILURE);
  });
});

describe("classifyUnauthorized / 確認的模型專屬失敗", () => {
  it("字串形式的 model_not_found 判定為模型專屬", () => {
    expect(classifyUnauthorized(JSON.stringify({ error: "model_not_found" }))).toBe(UnauthorizedOutcome.MODEL_SPECIFIC);
  });

  it("model … not available 的訊息判定為模型專屬", () => {
    const text = JSON.stringify({ error: { message: "model claude-x is not available on this gateway" } });
    expect(classifyUnauthorized(text)).toBe(UnauthorizedOutcome.MODEL_SPECIFIC);
  });

  it("中文「模型不支持」判定為模型專屬", () => {
    expect(classifyUnauthorized(JSON.stringify({ error: { message: "模型不支持" } }))).toBe(
      UnauthorizedOutcome.MODEL_SPECIFIC,
    );
  });
});

describe("classifyUnauthorized / 無法判定", () => {
  it("沒有內文（讀取失敗、逾時或過大）時無法判定", () => {
    expect(classifyUnauthorized(undefined)).toBe(UnauthorizedOutcome.UNDETERMINED);
  });

  it("空內文時無法判定", () => {
    expect(classifyUnauthorized("")).toBe(UnauthorizedOutcome.UNDETERMINED);
  });

  it("不含任何線索的純文字時無法判定", () => {
    expect(classifyUnauthorized("Unauthorized")).toBe(UnauthorizedOutcome.UNDETERMINED);
  });

  it("上游供應商的憑證被拒不是使用者的登入失效，無法判定", () => {
    const text = JSON.stringify({
      error: { message: "litellm.AuthenticationError: AnthropicException - invalid x-api-key" },
    });
    expect(classifyUnauthorized(text)).toBe(UnauthorizedOutcome.UNDETERMINED);
  });
});

describe("signInStateFor", () => {
  it("只有 key 失效才標記 expired，其餘一律 kept", () => {
    expect(signInStateFor(UnauthorizedOutcome.KEY_FAILURE)).toBe(SignInState.EXPIRED);
    expect(signInStateFor(UnauthorizedOutcome.MODEL_SPECIFIC)).toBe(SignInState.KEPT);
    expect(signInStateFor(UnauthorizedOutcome.UNDETERMINED)).toBe(SignInState.KEPT);
  });
});
