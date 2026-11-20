/**
 * @fileoverview 測試 loader fetch 攔截：Request／URL／字串輸入、標頭保留與合併、anthropic-version 判定、
 * 401 三種結果、429 提示與 Retry-After、2xx 與串流原樣交回
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { LitellmPlugin } from "../src/index.js";
import type { MagpieStoredAuth } from "../src/types.js";

const KEY = "fake-test-api-key-not-a-secret";
const AUTH: MagpieStoredAuth = { type: "api", key: KEY, metadata: { baseURL: "http://localhost:4000" } };

type FetchArgs = Parameters<typeof fetch>;

/** 監看全域 fetch 送出的參數，並依 respond 回傳測試回應 */
function mockUpstream(respond: (input: FetchArgs[0], init: FetchArgs[1]) => Response) {
  const fake = Object.assign(async (input: FetchArgs[0], init: FetchArgs[1]) => respond(input, init), {
    preconnect: globalThis.fetch.preconnect,
  });
  return spyOn(globalThis, "fetch").mockImplementation(fake);
}

/** 取得 loader 的 fetch 攔截器 */
async function interceptor(auth: MagpieStoredAuth = AUTH) {
  const plugin = await LitellmPlugin();
  const loader = await plugin.auth.loader(async () => auth);
  const fetchFn = loader.fetch;
  if (!fetchFn) throw new Error("loader 未提供 fetch");
  return fetchFn;
}

/** 讀取模擬上游收到的標頭 */
function sentHeaders(init: FetchArgs[1]): Headers {
  return new Headers(init?.headers);
}

/** 建立在指定毫秒後才送出內文的串流 */
function delayedBody(text: string, ms: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      }, ms);
    },
  });
}

let mock: ReturnType<typeof mockUpstream> | undefined;

afterEach(() => {
  mock?.mockRestore();
  mock = undefined;
});

describe("loader fetch / 輸入形式", () => {
  it.each([
    ["字串", () => "http://localhost:4000/v1/chat/completions"],
    ["URL 物件", () => new URL("http://localhost:4000/v1/chat/completions")],
    ["Request 物件", () => new Request("http://localhost:4000/v1/chat/completions", { method: "POST" })],
  ])("%s 輸入都會注入 Bearer、x-api-key 與來源標頭", async (_name, makeInput) => {
    mock = mockUpstream(() => new Response("{}", { status: 200 }));
    const fetchFn = await interceptor();
    await fetchFn(makeInput());

    const headers = sentHeaders(mock.mock.calls[0][1]);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("x-litellm-source")).toBe("magpie");
  });

  it("Request 的既有標頭會保留，且 init 標頭疊在上面覆寫同名欄位", async () => {
    mock = mockUpstream(() => new Response("{}", { status: 200 }));
    const fetchFn = await interceptor();
    const request = new Request("http://localhost:4000/v1/chat/completions", {
      headers: { "x-trace": "from-request", "x-shared": "request-value" },
    });

    await fetchFn(request, { headers: { "x-shared": "init-value", "x-extra": "from-init" } });

    const headers = sentHeaders(mock.mock.calls[0][1]);
    expect(headers.get("x-trace")).toBe("from-request");
    expect(headers.get("x-shared")).toBe("init-value");
    expect(headers.get("x-extra")).toBe("from-init");
  });
});

describe("loader fetch / anthropic-version", () => {
  it.each([
    ["Messages 路徑", "http://localhost:4000/v1/messages"],
    ["含查詢字串的 Messages 路徑", "http://localhost:4000/v1/messages?beta=true"],
    ["count_tokens 子路徑", "http://localhost:4000/v1/messages/count_tokens"],
  ])("%s 會補上 anthropic-version", async (_name, url) => {
    mock = mockUpstream(() => new Response("{}", { status: 200 }));
    const fetchFn = await interceptor();
    await fetchFn(url);

    expect(sentHeaders(mock.mock.calls[0][1]).get("anthropic-version")).toBe("2023-06-01");
  });

  it.each([
    ["查詢字串含 /messages 但路徑不是", "http://localhost:4000/v1/chat/completions?next=/messages"],
    ["路徑只是以 messages 開頭的其他字詞", "http://localhost:4000/v1/messages-archive"],
    ["路徑含 messagesX 字樣", "http://localhost:4000/v1/chat/messagesX"],
  ])("%s 不會補上 anthropic-version", async (_name, url) => {
    mock = mockUpstream(() => new Response("{}", { status: 200 }));
    const fetchFn = await interceptor();
    await fetchFn(url);

    expect(sentHeaders(mock.mock.calls[0][1]).has("anthropic-version")).toBe(false);
  });

  it("Request 來源已帶 anthropic-version 時保留原值", async () => {
    mock = mockUpstream(() => new Response("{}", { status: 200 }));
    const fetchFn = await interceptor();
    await fetchFn(new Request("http://localhost:4000/v1/messages", { headers: { "anthropic-version": "2024-01-01" } }));

    expect(sentHeaders(mock.mock.calls[0][1]).get("anthropic-version")).toBe("2024-01-01");
  });

  it("init 已帶 anthropic-version 時保留原值", async () => {
    mock = mockUpstream(() => new Response("{}", { status: 200 }));
    const fetchFn = await interceptor();
    await fetchFn("http://localhost:4000/v1/messages", { headers: { "anthropic-version": "2024-02-02" } });

    expect(sentHeaders(mock.mock.calls[0][1]).get("anthropic-version")).toBe("2024-02-02");
  });
});

describe("loader fetch / 401 三種結果", () => {
  const url = "http://localhost:4000/v1/chat/completions";

  it("確認的 key 失效標記 expired", async () => {
    mock = mockUpstream(
      () => new Response(JSON.stringify({ error: { message: "Expired key", type: "expired_key" } }), { status: 401 }),
    );
    const res = await (await interceptor())(url);

    expect(res.status).toBe(401);
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired");
  });

  it("確認的模型專屬失敗標記 kept", async () => {
    mock = mockUpstream(
      () => new Response(JSON.stringify({ error: { message: "model gpt-x is not available" } }), { status: 401 }),
    );
    const res = await (await interceptor())(url);

    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept");
  });

  it("空內文無法判定時標記 kept，不把健康帳號標成過期", async () => {
    mock = mockUpstream(() => new Response(null, { status: 401 }));
    const res = await (await interceptor())(url);

    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept");
  });

  it("內文讀取逾時（慢速 401）時標記 kept，且原內文仍可完整讀取", async () => {
    const payload = JSON.stringify({ error: { message: "Expired key", type: "expired_key" } });
    mock = mockUpstream(() => new Response(delayedBody(payload, 400), { status: 401 }));
    const res = await (await interceptor())(url);

    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept");
    expect(await res.text()).toBe(payload);
  });

  it("內文超過上限（過大）時標記 kept，即使前段含有 key 失效類型，且原內文仍完整", async () => {
    const payload = JSON.stringify({ error: { type: "expired_key" }, pad: "x".repeat(70 * 1024) });
    mock = mockUpstream(() => new Response(payload, { status: 401, headers: { "content-type": "application/json" } }));
    const res = await (await interceptor())(url);

    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept");
    expect(await res.text()).toBe(payload);
  });

  it("上游供應商的憑證被拒不標記 expired", async () => {
    mock = mockUpstream(
      () =>
        new Response(
          JSON.stringify({ error: { message: "litellm.AuthenticationError: AnthropicException - invalid" } }),
          {
            status: 401,
          },
        ),
    );
    const res = await (await interceptor())(url);

    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept");
  });
});

describe("loader fetch / 429、2xx 與串流", () => {
  const url = "http://localhost:4000/v1/chat/completions";

  it("429 保留 Retry-After 並補上限流說明，且只送出一次請求", async () => {
    const original = JSON.stringify({
      error: { message: "Rate limit exceeded for api_key", type: "throttling_error" },
    });
    mock = mockUpstream(
      () =>
        new Response(original, { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } }),
    );
    const res = await (await interceptor())(url);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    const body: any = await res.json();
    expect(body.error.message.startsWith("Rate limit exceeded for api_key")).toBe(true);
    expect(body.error.message).toContain("伺服器建議 7 秒後再試");
    expect(mock.mock.calls.length).toBe(1);
  });

  it("2xx 回應原樣交回同一個物件，不緩衝內文", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode("data: chunk\n\n"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const upstream = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    mock = mockUpstream(() => upstream);

    const res = await (await interceptor())(url);

    expect(res).toBe(upstream);
    expect(pulls).toBe(0);
    expect(await res.text()).toBe("data: chunk\n\n");
  });
});

describe("loader / baseURL 來源", () => {
  it("沒有 metadata 時使用 LITELLM_BASE_URL 環境變數", async () => {
    const previous = process.env.LITELLM_BASE_URL;
    process.env.LITELLM_BASE_URL = "http://from-env:4000";
    try {
      const plugin = await LitellmPlugin();
      const loader = await plugin.auth.loader(async () => ({ type: "api", key: KEY }));
      expect(loader.baseURL).toBe("http://from-env:4000/v1");
    } finally {
      if (previous === undefined) delete process.env.LITELLM_BASE_URL;
      else process.env.LITELLM_BASE_URL = previous;
    }
  });
});
