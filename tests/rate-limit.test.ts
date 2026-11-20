/**
 * @fileoverview 測試 LiteLLM 429 友善提示：來源分類、標頭保留、無法解析時原樣轉傳，以及不自動重試
 */

import { describe, expect, it } from "bun:test";
import { LitellmPlugin } from "../src/index.js";
import { enrichRateLimitResponse, parseRetryAfter } from "../src/rate-limit.js";

/**
 * 建立 429 測試回應
 * @private
 */
function tooManyRequests(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 429,
    statusText: "Too Many Requests",
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * 讀取改寫後回應的 error.message
 * @private
 */
async function readMessage(res: Response): Promise<string> {
  const json: any = await res.json();
  return json.error.message;
}

describe("enrichRateLimitResponse / 上游供應商限流", () => {
  it("上游 TPM 訊息標示上游限流與 TPM，保留原始訊息與其他欄位", async () => {
    const original =
      "litellm.RateLimitError: RateLimitError: OpenAIException - Rate limit reached for gpt-test in organization org-test on tokens per min (TPM): Limit 10000, Used 9800, Requested 500.";
    const res = tooManyRequests(
      JSON.stringify({ error: { message: original, type: "throttling_error", param: null, code: "429" } }),
    );

    const out = await enrichRateLimitResponse(res);

    expect(out.status).toBe(429);
    const json: any = await out.json();
    expect(json.error.message).toContain("上游供應商限流");
    expect(json.error.message).toContain("每分鐘 Token 用量（TPM）");
    expect(json.error.message.startsWith(original)).toBe(true);
    expect(json.error.type).toBe("throttling_error");
    expect(json.error.param).toBeNull();
    expect(json.error.code).toBe("429");
  });

  it("上游只說 token throughput 時，不把時間單位猜成每分鐘", async () => {
    const message =
      "litellm.RateLimitError: AzureException - This request has exceeded the token rate limit for this deployment.";
    const res = tooManyRequests(JSON.stringify({ error: { message } }));

    expect(await readMessage(await enrichRateLimitResponse(res))).toBe(
      `${message} [上游供應商限流：Token 吞吐量已達上限]`,
    );
  });

  it("Anthropic 形狀且明確提到 input tokens per minute 時標示 TPM，來源未知", async () => {
    const res = tooManyRequests(
      JSON.stringify({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "This request would exceed your organization's rate limit of 30,000 input tokens per minute",
        },
      }),
    );

    const out = await enrichRateLimitResponse(res);
    const json: any = await out.json();

    expect(json.type).toBe("error");
    expect(json.error.type).toBe("rate_limit_error");
    expect(json.error.message).toContain("429 請求過多（來源未知）");
    expect(json.error.message).toContain("每分鐘 Token 用量（TPM）");
  });
});

describe("enrichRateLimitResponse / LiteLLM 閘道限流", () => {
  it("依 rate_limit_type 標頭標示 RPM，並附上有效 Retry-After 秒數", async () => {
    const res = tooManyRequests(
      JSON.stringify({
        error: {
          message:
            "Rate limit exceeded for api_key: abc123... Limit type: requests. Current limit: 1, Remaining: 0. Limit resets at: 2026-08-27 00:15:18 UTC",
          type: "throttling_error",
          param: null,
          code: "429",
        },
      }),
      { rate_limit_type: "requests", rate_limited_by: "api_key", "retry-after": "42" },
    );

    const out = await enrichRateLimitResponse(res);

    expect(await readMessage(out)).toBe(
      "Rate limit exceeded for api_key: abc123... Limit type: requests. Current limit: 1, Remaining: 0. Limit resets at: 2026-08-27 00:15:18 UTC [LiteLLM 閘道限流：金鑰 · 每分鐘請求數（RPM）已達上限，伺服器建議 42 秒後再試]",
    );
  });

  it("沒有標頭時仍可從訊息的 Limit type 辨識並標示並行限流", async () => {
    const res = tooManyRequests(
      JSON.stringify({
        error: {
          message: "Rate limit exceeded for team: t1. Limit type: concurrent_requests. Current limit: 2",
          type: "throttling_error",
        },
      }),
    );

    const out = await enrichRateLimitResponse(res);

    expect(await readMessage(out)).toContain("LiteLLM 閘道限流：團隊 · 並行請求數已達上限");
  });

  it("預算耗盡由 budget_exceeded 型別辨識", async () => {
    const res = tooManyRequests(
      JSON.stringify({
        error: { message: "Budget has been exceeded! Current cost: 0.06, Max budget: 0.05", type: "budget_exceeded" },
      }),
    );

    const out = await enrichRateLimitResponse(res);

    expect(await readMessage(out)).toContain("[預算已用盡]");
  });

  it("部署冷卻由 No deployments available 前綴辨識", async () => {
    const res = tooManyRequests(
      JSON.stringify({
        error: { message: "No deployments available for selected model, cooling: 12s", type: "throttling_error" },
      }),
      { "retry-after": "12" },
    );

    const out = await enrichRateLimitResponse(res);

    expect(await readMessage(out)).toContain("[LiteLLM 部署冷卻中，模型群組內的部署暫時停用，伺服器建議 12 秒後再試]");
  });
});

describe("enrichRateLimitResponse / 無法辨識與降級", () => {
  it("無法辨識來源的 JSON 429 標示來源未知，沒有 Retry-After 時不加等待提示", async () => {
    const res = tooManyRequests(JSON.stringify({ error: { message: "slow down", type: "throttling_error" } }));

    const out = await enrichRateLimitResponse(res);

    expect(await readMessage(out)).toBe("slow down [429 請求過多（來源未知）]");
  });

  it("原文同時提到 TPM 與 RPM 時不猜測觸發的維度", async () => {
    const message = "Rate limit reached; check both requests per minute and tokens per minute";
    const res = tooManyRequests(JSON.stringify({ error: { message } }), { "retry-after": "15" });

    expect(await readMessage(await enrichRateLimitResponse(res))).toBe(
      `${message} [429 請求過多（來源未知），伺服器建議 15 秒後再試]`,
    );
  });

  it("只提到檢查 TPM 設定時，不把 TPM 當成觸發原因", async () => {
    for (const message of [
      "Rate limit reached. Review TPM settings in the dashboard.",
      "The request exceeded a separate request cap, check TPM settings.",
    ]) {
      const res = tooManyRequests(JSON.stringify({ error: { message } }));
      expect(await readMessage(await enrichRateLimitResponse(res))).toBe(`${message} [429 請求過多（來源未知）]`);
    }
  });

  it("兩個維度都明確超限時，不猜測單一原因", async () => {
    const message = "RPM limit exceeded; TPM limit exceeded.";
    const res = tooManyRequests(JSON.stringify({ error: { message } }));

    expect(await readMessage(await enrichRateLimitResponse(res))).toBe(`${message} [429 請求過多（來源未知）]`);
  });

  it("非 JSON 內文原樣回傳同一個 Response", async () => {
    const res = tooManyRequests("Too many requests, try later", { "retry-after": "5" });

    const out = await enrichRateLimitResponse(res);

    expect(out).toBe(res);
    expect(out.status).toBe(429);
    expect(await out.text()).toBe("Too many requests, try later");
  });

  it("JSON 缺少字串 error.message 時原樣回傳", async () => {
    const body = JSON.stringify({ error: { code: "429" } });
    const res = tooManyRequests(body);

    const out = await enrichRateLimitResponse(res);

    expect(out).toBe(res);
    expect(await out.text()).toBe(body);
  });

  it("429 的 SSE 串流也原樣轉傳，不等待串流關閉", async () => {
    const res = new Response(new ReadableStream(), { status: 429, headers: { "content-type": "text/event-stream" } });

    expect(await enrichRateLimitResponse(res)).toBe(res);
  });

  it("明確不是 JSON 的 429 不預讀內文", async () => {
    const res = new Response(new ReadableStream(), { status: 429, headers: { "content-type": "text/html" } });

    expect(await enrichRateLimitResponse(res)).toBe(res);
    expect(res.bodyUsed).toBe(false);
  });

  it("宣告內文超過上限時不預讀", async () => {
    const res = tooManyRequests(JSON.stringify({ error: { message: "TPM limit exceeded" } }), {
      "content-length": "65537",
    });

    expect(await enrichRateLimitResponse(res)).toBe(res);
    expect(res.bodyUsed).toBe(false);
  });

  it("未宣告長度但讀到超過上限時，保留完整的原始內文", async () => {
    const payload = JSON.stringify({ error: { message: "訊".repeat(24_000) } });
    const bytes = new TextEncoder().encode(payload);
    const res = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 40_000));
          controller.enqueue(bytes.subarray(40_000));
          controller.close();
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );

    expect(await enrichRateLimitResponse(res)).toBe(res);
    expect(await res.text()).toBe(payload);
  });

  it("JSON 尚未送完時在讀取期限後原樣轉傳，原始分支仍可讀取", async () => {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const payload = JSON.stringify({ error: { message: "TPM limit reached" } });
    const res = new Response(readable, { status: 429, headers: { "content-type": "application/json" } });

    try {
      // 只送出前半段且不關閉串流，直到外掛交回回應為止。
      const firstChunk = writer.write(new TextEncoder().encode(payload.slice(0, 10)));
      expect(await enrichRateLimitResponse(res)).toBe(res);
      await firstChunk;
      expect(res.bodyUsed).toBe(false);
      const originalText = res.text();
      await writer.write(new TextEncoder().encode(payload.slice(10)));
      await writer.close();
      expect(await originalText).toBe(payload);
    } finally {
      await writer.abort().catch(() => undefined);
    }
  }, 2000);

  it("非 429 回應原樣回傳，不改寫成功或其他錯誤", async () => {
    const res = new Response(JSON.stringify({ error: { message: "Rate limit" } }), { status: 500 });

    expect(await enrichRateLimitResponse(res)).toBe(res);
  });
});

describe("enrichRateLimitResponse / 標頭保留", () => {
  it("改寫後保留 status、statusText、Retry-After，並移除過時的 content-length／content-encoding", async () => {
    const res = tooManyRequests(
      JSON.stringify({
        error: { message: "Rate limit exceeded for api_key: x. Limit type: tokens.", type: "throttling_error" },
      }),
      { "retry-after": "9", "content-length": "999", "content-encoding": "gzip", "x-litellm-call-id": "call-1" },
    );

    const out = await enrichRateLimitResponse(res);

    expect(out.status).toBe(429);
    expect(out.statusText).toBe("Too Many Requests");
    expect(out.headers.get("retry-after")).toBe("9");
    expect(out.headers.get("x-litellm-call-id")).toBe("call-1");
    expect(out.headers.get("content-length")).not.toBe("999");
    expect(out.headers.get("content-encoding")).toBeNull();
    expect(await readMessage(out)).toContain("金鑰 · 每分鐘 Token 用量（TPM）已達上限，伺服器建議 9 秒後再試");
  });
});

describe("parseRetryAfter", () => {
  it("接受秒數與 HTTP-date，並忽略無效值", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");

    expect(parseRetryAfter("7", now)).toBe(7);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:27:00 GMT", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("1.5", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
    expect(parseRetryAfter("Thu, 31 Feb 2040 07:28:30 GMT", now)).toBeUndefined();
    expect(parseRetryAfter("9".repeat(310), now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it("接受 RFC 9110 的三種日期格式，且 asctime 一律以 GMT 解讀", () => {
    const now = Date.parse("Sun, 06 Nov 1994 08:49:30 GMT");

    expect(parseRetryAfter("Sun, 06 Nov 1994 08:49:37 GMT", now)).toBe(7);
    expect(parseRetryAfter("Sunday, 06-Nov-94 08:49:37 GMT", now)).toBe(7);
    expect(parseRetryAfter("Sun Nov  6 08:49:37 1994", now)).toBe(7);
    expect(parseRetryAfter("Mon Nov  6 08:49:37 1994", now)).toBeUndefined();
  });

  it("RFC 850 的兩位數年份跨世紀解讀，且不採用超過 50 年的未來日期", () => {
    const now = Date.parse("Thu, 31 Dec 2099 23:59:58 GMT");

    expect(parseRetryAfter("Friday, 01-Jan-00 00:00:00 GMT", now)).toBe(2);
    expect(parseRetryAfter("Wednesday, 01-Jan-49 00:00:00 GMT", now)).toBe((Date.UTC(2149, 0, 1) - now) / 1000);
    expect(parseRetryAfter("Thursday, 01-Jan-50 00:00:00 GMT", now)).toBeUndefined();
  });
});

describe("LitellmPlugin / loader 429 行為", () => {
  it("429 只送出一次請求、不自動重試，並回傳改寫後的提示", async () => {
    const plugin = await LitellmPlugin();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        calls += 1;
        return tooManyRequests(
          JSON.stringify({
            error: { message: "Rate limit exceeded for api_key: k. Limit type: requests.", type: "throttling_error" },
          }),
          { rate_limit_type: "requests", "retry-after": "3" },
        );
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      const loader = await plugin.auth.loader(async () => ({
        type: "api",
        key: "fixture-key",
        metadata: { baseURL: "http://localhost:4000" },
      }));
      const res = await loader.fetch!("http://localhost:4000/v1/chat/completions", { method: "POST" });

      expect(calls).toBe(1);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("3");
      expect(await readMessage(res)).toBe(
        "Rate limit exceeded for api_key: k. Limit type: requests. [LiteLLM 閘道限流：金鑰 · 每分鐘請求數（RPM）已達上限，伺服器建議 3 秒後再試]",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
