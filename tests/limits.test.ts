/**
 * @fileoverview 測試模型上限查表與 models.dev 快取行為
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateLookups, loadCatalog, lookupLimit, type ModelsDevCatalog } from "../src/limits.js";

const catalog: ModelsDevCatalog = {
  azure: { models: { "claude-sonnet-5-5": { limit: { context: 1000000, output: 128000 } } } },
  zhipuai: { models: { "glm-5.3": { limit: { context: 1000000, output: 131072 } } } },
};

describe("limits / lookupLimit", () => {
  it("azure_ai 前綴會去掉並查 azure provider", () => {
    expect(lookupLimit(catalog, "azure_ai/claude-sonnet-5-5")).toEqual({ context: 1000000, output: 128000 });
  });

  it("查得到的 GLM 使用它自己的上限，不會誤用 Claude 的值", () => {
    expect(lookupLimit(catalog, "glm-5.3")).toEqual({ context: 1000000, output: 131072 });
  });

  it("目錄查不到時回傳 undefined", () => {
    expect(lookupLimit(catalog, "azure_ai/unknown-model")).toBeUndefined();
  });

  it("沒有 output 的條目視為無效", () => {
    const partial: ModelsDevCatalog = { azure: { models: { x: { limit: { context: 10 } } } } };
    expect(lookupLimit(partial, "azure_ai/x")).toBeUndefined();
  });

  it("候選順序：azure_ai 先查 azure，再查 anthropic", () => {
    const c = candidateLookups("azure_ai/claude-opus-5");
    expect(c[0]).toEqual({ provider: "azure", id: "claude-opus-5" });
    expect(c[1]).toEqual({ provider: "anthropic", id: "claude-opus-5" });
  });
});

describe("limits / 候選與官方來源", () => {
  const withMoonshot: ModelsDevCatalog = {
    moonshotai: { models: { "kimi-k3": { limit: { context: 1048576, output: 1048576 } } } },
    neon: { models: { "kimi-k3": { limit: { context: 1048576, output: 65536 } } } },
  };

  it("去掉 Foundry 的 FW- 前綴後仍能查到", () => {
    const c: ModelsDevCatalog = { zhipuai: { models: { "glm-5.3": { limit: { context: 1000000, output: 131072 } } } } };
    expect(lookupLimit(c, "azure_ai/FW-GLM-5.3")).toEqual({ context: 1000000, output: 131072 });
  });

  it("不掃描非官方 provider：同名模型只取官方來源的值", () => {
    expect(lookupLimit(withMoonshot, "Kimi-K3")).toEqual({ context: 1048576, output: 1048576 });
    const onlyNeon: ModelsDevCatalog = { neon: withMoonshot.neon! };
    expect(lookupLimit(onlyNeon, "Kimi-K3")).toBeUndefined();
  });
});

describe("limits / loadCatalog cache", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "limits-"));
  const payload = { anthropic: { models: { "claude-x": { limit: { context: 1, output: 2 } } } } };

  it("快取未過期時不呼叫網路", async () => {
    const path = join(dir(), "c.json");
    await Bun.write(path, JSON.stringify({ fetchedAt: 1000, catalog: payload }));
    let called = false;
    const got = await loadCatalog(path, async () => { called = true; return new Response("{}"); }, () => 1000 + 60_000);
    expect(called).toBe(false);
    expect(got).toEqual(payload);
  });

  it("快取過期時下載並寫回", async () => {
    const path = join(dir(), "c.json");
    await Bun.write(path, JSON.stringify({ fetchedAt: 0, catalog: {} }));
    const got = await loadCatalog(path, async () => new Response(JSON.stringify(payload)), () => 25 * 60 * 60 * 1000);
    expect(got).toEqual(payload);
    const saved = await Bun.file(path).json();
    expect(saved.catalog).toEqual(payload);
  });

  it("下載失敗時退回舊快取", async () => {
    const path = join(dir(), "c.json");
    await Bun.write(path, JSON.stringify({ fetchedAt: 0, catalog: payload }));
    const got = await loadCatalog(path, async () => new Response("err", { status: 500 }), () => 25 * 60 * 60 * 1000);
    expect(got).toEqual(payload);
  });

  it("無快取且下載失敗時回傳 undefined", async () => {
    const path = join(dir(), "none.json");
    const got = await loadCatalog(path, async () => { throw new Error("offline"); });
    expect(got).toBeUndefined();
  });

  it("下載逾時（連線黑洞）時不無限等待，退回舊快取", async () => {
    const path = join(dir(), "c.json");
    await Bun.write(path, JSON.stringify({ fetchedAt: 0, catalog: payload }));
    // 只在 abort 時才結束的請求，模擬不回應也不斷線
    // 沒有 signal 時永遠不結束，讓測試在未設定逾時時失敗，而不是靜默通過
    const hang = (_url: string, signal: AbortSignal) =>
      new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const got = await loadCatalog(path, hang, () => 25 * 60 * 60 * 1000, 20);
    expect(got).toEqual(payload);
  });

  it("快取寫入失敗（父目錄是一般檔案）時，仍回傳這次下載成功的目錄", async () => {
    const blocker = join(dir(), "not-a-dir");
    await Bun.write(blocker, "x");
    const path = join(blocker, "c.json");
    const got = await loadCatalog(path, async () => new Response(JSON.stringify(payload)));
    expect(got).toEqual(payload);
  });
});
