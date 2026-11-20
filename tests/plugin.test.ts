/**
 * @fileoverview 測試 Magpie 外掛生命週期 Hooks 與 Header 注入行為
 */

import { describe, expect, it } from "bun:test";
import { LitellmPlugin, PROVIDER_ID } from "../src/index.js";
import { ModelProtocolPackage } from "../src/types.js";

describe("LitellmPlugin / config", () => {
  it("宣告預設 Provider 與 fallback 模型", async () => {
    const plugin = await LitellmPlugin();
    const configObj: any = {};
    await plugin.config(configObj);

    expect(configObj.provider[PROVIDER_ID]).toBeDefined();
    expect(configObj.provider[PROVIDER_ID].name).toBe("LiteLLM");
    expect(configObj.provider[PROVIDER_ID].models["claude-3-7-sonnet"].npm).toBe(ModelProtocolPackage.ANTHROPIC);
  });
});

describe("LitellmPlugin / loader fetch", () => {
  it("同時注入 Bearer 與 x-api-key 雙標頭", async () => {
    const plugin = await LitellmPlugin();

    let capturedHeaders: Headers | undefined;
    const originalFetch = globalThis.fetch;
    // Mock 全域 fetch 驗證送出的 headers
    globalThis.fetch = (async (input: any, init: any) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    try {
      const authData = {
        type: "api",
        key: "fake-test-api-key-not-a-secret",
        metadata: { baseURL: "http://localhost:4000" },
      };
      const loader = await plugin.auth.loader(async () => authData as any);
      expect(loader.baseURL).toBe("http://localhost:4000/v1");

      await loader.fetch!("http://localhost:4000/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      expect(capturedHeaders?.get("authorization")).toBe("Bearer fake-test-api-key-not-a-secret");
      expect(capturedHeaders?.get("x-api-key")).toBe("fake-test-api-key-not-a-secret");
      expect(capturedHeaders?.get("x-litellm-source")).toBe("magpie");
      expect(capturedHeaders?.get("anthropic-version")).toBe("2023-06-01");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("遭遇 401 且若明確為模型未提供時標記 kept", async () => {
    const plugin = await LitellmPlugin();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: "model_not_found" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      const authData = {
        type: "api",
        key: "fake-test-api-key-not-a-secret",
        metadata: { baseURL: "http://localhost:4000" },
      };
      const loader = await plugin.auth.loader(async () => authData as any);
      const res = await loader.fetch!("http://localhost:4000/v1/chat/completions");

      expect(res.status).toBe(401);
      expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("LitellmPlugin / provider.models 保留既有清單", () => {
  it("兩個探索端點都失敗時回傳 Magpie 既有的同一個清單物件", async () => {
    // 假 gateway 兩端點皆 404：不會進入目錄載入，因此不連 models.dev、也不寫入真實 ~/.cache
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("nope", { status: 404 }) });
    try {
      const plugin = await LitellmPlugin();
      const existing = { "acme-coder": { id: "acme-coder", name: "acme-coder" } };
      const out = await plugin.provider.models(
        { models: existing },
        {
          auth: {
            type: "api",
            key: "fake-test-api-key-not-a-secret",
            metadata: { baseURL: `http://127.0.0.1:${server.port}` },
          },
        },
      );
      expect(out).toBe(existing);
    } finally {
      server.stop(true);
    }
  });
});

describe("LitellmPlugin / chat.headers", () => {
  it("注入對話 sessionID 至 x-litellm-session-id 標頭", async () => {
    const plugin = await LitellmPlugin();
    const chatHeadersHook = (plugin as any)["chat.headers"];

    const input = {
      model: { providerID: PROVIDER_ID },
      sessionID: "sess-abc-123",
    };
    const output = { headers: {} as Record<string, string> };

    await chatHeadersHook(input, output);
    expect(output.headers["x-litellm-session-id"]).toBe("sess-abc-123");
  });
});
