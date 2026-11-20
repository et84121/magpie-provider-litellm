/**
 * @fileoverview 測試模型探索的端點階梯、列級容錯、路由判斷與目錄上限使用。
 * HTTP 行為以本機假 gateway（127.0.0.1 隨機埠）驗證；外部目錄一律注入，不連 models.dev。
 */

import { afterEach, describe, expect, it } from "bun:test";
import { type DiscoveredModel, discoverModels } from "../src/discovery.js";
import type { ModelsDevCatalog } from "../src/limits.js";
import { resolveReasoning } from "../src/protocol.js";
import { ModelProtocolPackage } from "../src/types.js";

type Route = () => Response;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** 本機假 gateway：只回應指定路徑，其餘 404；紀錄收到的路徑與認證標頭 */
function fakeGateway(routes: Record<string, Route>) {
  const seen: Array<{ path: string; auth: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ path, auth: req.headers.get("authorization") });
      const route = routes[path];
      return route ? route() : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, seen };
}

/** 計數的外部目錄注入：記錄是否被讀取 */
function countedCatalog(catalog?: ModelsDevCatalog) {
  const probe = {
    calls: 0,
    load: async () => {
      probe.calls += 1;
      return catalog;
    },
  };
  return probe;
}

const NO_CATALOG = countedCatalog();
const KEY = "fake-test-api-key-not-a-secret";

function discover(base: string, extra: Partial<Parameters<typeof discoverModels>[0]> = {}) {
  return discoverModels({
    rootUrl: base,
    apiBase: `${base}/v1`,
    apiKey: KEY,
    loadExternal: NO_CATALOG.load,
    ...extra,
  });
}

const CLAUDE_CATALOG: ModelsDevCatalog = {
  azure: { models: { "claude-sonnet-5-5": { limit: { context: 1000000, output: 128000 } } } },
};

describe("discovery / 端點階梯與失敗", () => {
  it("優先使用 /model/info，並以 Bearer 認證", async () => {
    const gw = fakeGateway({
      "/model/info": () =>
        json({ data: [{ model_name: "claude-alias", model_info: { max_input_tokens: 9, max_output_tokens: 9 } }] }),
      "/v1/models": () => json({ data: [{ id: "不應被使用" }] }),
    });
    const models = await discover(gw.base);
    expect(Object.keys(models!)).toEqual(["claude-alias"]);
    expect(gw.seen.map((s) => s.path)).toEqual(["/model/info"]);
    expect(gw.seen[0].auth).toBe(`Bearer ${KEY}`);
  });

  it("/model/info 回 404 時退回 /v1/models", async () => {
    const gw = fakeGateway({ "/v1/models": () => json({ data: [{ id: "deepseek-chat" }] }) });
    const models = await discover(gw.base);
    expect(Object.keys(models!)).toEqual(["deepseek-chat"]);
    expect(gw.seen.map((s) => s.path)).toEqual(["/model/info", "/v1/models"]);
  });

  it("/model/info 回傳非 JSON 時退回 /v1/models", async () => {
    const gw = fakeGateway({
      "/model/info": () => new Response("<html>maintenance</html>", { status: 200 }),
      "/v1/models": () => json({ data: [{ id: "gpt-x" }] }),
    });
    expect(Object.keys((await discover(gw.base))!)).toEqual(["gpt-x"]);
  });

  it("兩個端點都回傳不可用內容時回傳 undefined，交由呼叫端保留既有清單", async () => {
    const gw = fakeGateway({
      "/model/info": () => json({ error: "forbidden" }, 403),
      "/v1/models": () => json({ data: "not-an-array" }),
    });
    expect(await discover(gw.base)).toBeUndefined();
  });

  it("連線被拒（傳輸失敗）時回傳 undefined", async () => {
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const base = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    expect(await discover(base)).toBeUndefined();
  });

  it("/model/info 權威空清單（data: []）回傳空物件，不降級到 /v1/models", async () => {
    const gw = fakeGateway({
      "/model/info": () => json({ data: [] }),
      "/v1/models": () => json({ data: [{ id: "不應被使用" }] }),
    });
    expect(await discover(gw.base)).toEqual({});
    expect(gw.seen.map((s) => s.path)).toEqual(["/model/info"]);
  });

  it("/v1/models 權威空清單回傳空物件", async () => {
    const gw = fakeGateway({ "/v1/models": () => json({ data: [] }) });
    expect(await discover(gw.base)).toEqual({});
  });

  it("/model/info 只有 wildcard 或損毀列（無任何可用列）時退回 /v1/models", async () => {
    const gw = fakeGateway({
      "/model/info": () => json({ data: [{ model_name: "openai/*" }, { model_name: 5 }, null] }),
      "/v1/models": () => json({ data: [{ id: "gpt-x" }] }),
    });
    expect(Object.keys((await discover(gw.base))!)).toEqual(["gpt-x"]);
    expect(gw.seen.map((s) => s.path)).toEqual(["/model/info", "/v1/models"]);
  });
});

describe("discovery / 列級容錯與 ID 驗證", () => {
  it("單列 model_name 不合時只略過該列，其他可用列保留", async () => {
    const gw = fakeGateway({
      "/model/info": () =>
        json({
          data: [
            { model_name: 5 },
            { model_name: "good-model" },
            { litellm_params: {} },
            { model_name: "  " },
            { model_name: " padded" },
            { model_name: "wild*" },
            "not-an-object",
          ],
        }),
    });
    expect(Object.keys((await discover(gw.base))!)).toEqual(["good-model"]);
  });

  it("/v1/models 的缺 id、null、wildcard、非字串 id 皆略過，不產生 undefined 模型", async () => {
    const gw = fakeGateway({
      "/v1/models": () => json({ data: [{ id: "a-model" }, {}, null, { id: "x*" }, { id: 3 }] }),
    });
    expect(Object.keys((await discover(gw.base))!)).toEqual(["a-model"]);
  });

  it("metadata 型別錯誤只視為沒有證據，不丟掉模型", async () => {
    const gw = fakeGateway({
      "/model/info": () =>
        json({
          data: [
            {
              model_name: "m1",
              model_info: {
                mode: 123,
                supports_function_calling: "yes",
                max_input_tokens: "big",
                max_output_tokens: 8000,
              },
            },
          ],
        }),
    });
    const m1 = (await discover(gw.base))!["m1"];
    expect(m1.capabilities.toolcall).toBe(true);
    expect(m1.limit).toEqual({ context: 128000, output: 8000 });
  });

  it("同名多個部署的上限取最小值，與列的順序無關", async () => {
    const gw = fakeGateway({
      "/model/info": () =>
        json({
          data: [
            { model_name: "m", model_info: { max_input_tokens: 2000, max_output_tokens: 200 } },
            { model_name: "m", model_info: { max_input_tokens: 1000, max_output_tokens: 300 } },
          ],
        }),
    });
    expect((await discover(gw.base))!["m"].limit).toEqual({ context: 1000, output: 200 });
  });

  it("同名列中全空的部署不遮蔽有明確 metadata 的部署", async () => {
    const gw = fakeGateway({
      "/model/info": () =>
        json({
          data: [
            { model_name: "claude-alias", litellm_params: { model: "azure_ai/claude-sonnet-5-5" } },
            {
              model_name: "claude-alias",
              litellm_params: { model: "anthropic/claude-sonnet-5-5" },
              model_info: { litellm_provider: "anthropic", max_input_tokens: 200000, max_output_tokens: 64000 },
            },
          ],
        }),
    });
    const model = (await discover(gw.base, { loadExternal: NO_CATALOG.load }))!["claude-alias"];
    expect(model.limit).toEqual({ context: 200000, output: 64000 });
    expect(model.api.npm).toBe(ModelProtocolPackage.ANTHROPIC);
  });

  it("模型 ID 內部含空白合法，頭尾空白則略過", async () => {
    const gw = fakeGateway({
      "/model/info": () => json({ data: [{ model_name: "my model" }, { model_name: " padded" }] }),
    });
    expect(Object.keys((await discover(gw.base))!)).toEqual(["my model"]);
  });
});

describe("discovery / 路由與決策模型", () => {
  it("明確的非對話 mode 略過，且不因此降級到 /v1/models 補回", async () => {
    const gw = fakeGateway({
      "/model/info": () =>
        json({
          data: [
            { model_name: "emb", model_info: { mode: "embedding" } },
            { model_name: "img", model_info: { mode: "image_generation" } },
          ],
        }),
      "/v1/models": () => json({ data: [{ id: "emb" }, { id: "chat-x" }] }),
    });
    expect(await discover(gw.base)).toEqual({});
    expect(gw.seen.map((s) => s.path)).toEqual(["/model/info"]);
  });

  it("語音、OCR、realtime 等明確非對話 mode 同樣略過；未列入的 mode 不靠猜測排除", async () => {
    const gw = fakeGateway({
      "/model/info": () =>
        json({
          data: [
            { model_name: "stt", model_info: { mode: "audio_transcription" } },
            { model_name: "tts", model_info: { mode: "audio_speech" } },
            { model_name: "ocr", model_info: { mode: "ocr" } },
            { model_name: "rt", model_info: { mode: "realtime" } },
            { model_name: "odd", model_info: { mode: "extraction" } },
          ],
        }),
    });
    expect(Object.keys((await discover(gw.base))!)).toEqual(["odd"]);
  });

  it("/v1/models 的 Decision-1 無 metadata 時仍標記為決策模型，且不開啟 tool call", async () => {
    const gw = fakeGateway({ "/v1/models": () => json({ data: [{ id: "Decision-1" }] }) });
    const decision: DiscoveredModel = (await discover(gw.base))!["Decision-1"];
    expect(decision.decides).toBe(true);
    expect(decision.capabilities.toolcall).toBe(false);
    expect(decision.capabilities.reasoning).toBe(false);
  });

  it("明確的 supports_reasoning 優先於名稱推論（含 false）", async () => {
    const gw = fakeGateway({
      "/model/info": () =>
        json({
          data: [
            { model_name: "o1-mini", model_info: { supports_reasoning: false } },
            { model_name: "custom-x", model_info: { supports_reasoning: true } },
          ],
        }),
    });
    const models = (await discover(gw.base))!;
    expect(models["o1-mini"].capabilities.reasoning).toBe(false);
    expect(models["custom-x"].capabilities.reasoning).toBe(true);
  });

  it("推理名稱推論不誤判子字串（tr1 不算 r1）", () => {
    expect(resolveReasoning("tr1-model")).toBe(false);
    expect(resolveReasoning("o3-mini")).toBe(true);
    expect(resolveReasoning("deepseek-reasoner")).toBe(true);
  });

  it("Claude 依 litellm_provider 走 Anthropic 協定，OpenAI 新架構走 Responses", async () => {
    const gw = fakeGateway({
      "/model/info": () =>
        json({
          data: [
            {
              model_name: "ops-model",
              model_info: { litellm_provider: "anthropic", max_input_tokens: 1, max_output_tokens: 1 },
            },
            { model_name: "gpt-4o", model_info: { max_input_tokens: 1, max_output_tokens: 1 } },
          ],
        }),
    });
    const models = (await discover(gw.base))!;
    expect(models["ops-model"].api.npm).toBe(ModelProtocolPackage.ANTHROPIC);
    expect(models["gpt-4o"].api.npm).toBe(ModelProtocolPackage.OPENAI_RESPONSES);
  });

  it("wire ID 一律是 model_name，上游部署名只用來查上限", async () => {
    const gw = fakeGateway({
      "/model/info": () =>
        json({
          data: [
            { model_name: "claude-alias", litellm_params: { model: "azure_ai/claude-sonnet-5-5" }, model_info: {} },
          ],
        }),
    });
    const catalog = countedCatalog(CLAUDE_CATALOG);
    const model = (await discover(gw.base, { loadExternal: catalog.load }))!["claude-alias"];
    expect(model.id).toBe("claude-alias");
    expect(model.api.id).toBe("claude-alias");
    expect(model.api.url).toBe(`${gw.base}/v1`);
    expect(model.limit).toEqual({ context: 1000000, output: 128000 });
  });
});

describe("discovery / 目錄上限的使用時機", () => {
  it("每列都有明確上限（含 legacy max_tokens 當輸出）時不讀取外部目錄", async () => {
    const gw = fakeGateway({
      "/model/info": () => json({ data: [{ model_name: "a", model_info: { max_input_tokens: 10, max_tokens: 20 } }] }),
    });
    const catalog = countedCatalog(CLAUDE_CATALOG);
    await discover(gw.base, { loadExternal: catalog.load });
    expect(catalog.calls).toBe(0);
  });

  it("只有非對話列缺上限時不讀取外部目錄", async () => {
    const gw = fakeGateway({
      "/model/info": () => json({ data: [{ model_name: "emb", model_info: { mode: "embedding" } }] }),
    });
    const catalog = countedCatalog(CLAUDE_CATALOG);
    await discover(gw.base, { loadExternal: catalog.load });
    expect(catalog.calls).toBe(0);
  });

  it("缺上限的列才讀取外部目錄，上游已知的 context 優先於目錄", async () => {
    const gw = fakeGateway({
      "/model/info": () =>
        json({
          data: [
            {
              model_name: "a",
              litellm_params: { model: "azure_ai/claude-sonnet-5-5" },
              model_info: { max_input_tokens: 5 },
            },
          ],
        }),
    });
    const catalog = countedCatalog(CLAUDE_CATALOG);
    const model = (await discover(gw.base, { loadExternal: catalog.load }))!["a"];
    expect(catalog.calls).toBe(1);
    expect(model.limit).toEqual({ context: 5, output: 128000 });
  });

  it("外部目錄讀取失敗時使用保底值，探索本身仍成功", async () => {
    const gw = fakeGateway({ "/model/info": () => json({ data: [{ model_name: "a" }] }) });
    const models = await discover(gw.base, {
      loadExternal: async () => {
        throw new Error("offline");
      },
    });
    expect(models!["a"].limit).toEqual({ context: 128000, output: 4096 });
  });

  it("/v1/models 沒有 metadata 時以模型 ID 查外部目錄", async () => {
    const gw = fakeGateway({ "/v1/models": () => json({ data: [{ id: "claude-sonnet-5-5" }] }) });
    const catalog = countedCatalog(CLAUDE_CATALOG);
    const model = (await discover(gw.base, { loadExternal: catalog.load }))!["claude-sonnet-5-5"];
    expect(model.limit).toEqual({ context: 1000000, output: 128000 });
    expect(model.api.npm).toBe(ModelProtocolPackage.ANTHROPIC);
  });
});
