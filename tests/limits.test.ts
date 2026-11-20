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
    const got = await loadCatalog(
      path,
      async () => {
        called = true;
        return new Response("{}");
      },
      () => 1000 + 60_000,
    );
    expect(called).toBe(false);
    expect(got).toEqual(payload);
  });

  it("快取過期時下載並寫回", async () => {
    const path = join(dir(), "c.json");
    await Bun.write(path, JSON.stringify({ fetchedAt: 0, catalog: {} }));
    const got = await loadCatalog(
      path,
      async () => new Response(JSON.stringify(payload)),
      () => 25 * 60 * 60 * 1000,
    );
    expect(got).toEqual(payload);
    const saved = await Bun.file(path).json();
    expect(saved.catalog).toEqual(payload);
  });

  it("下載失敗時退回舊快取", async () => {
    const path = join(dir(), "c.json");
    await Bun.write(path, JSON.stringify({ fetchedAt: 0, catalog: payload }));
    const got = await loadCatalog(
      path,
      async () => new Response("err", { status: 500 }),
      () => 25 * 60 * 60 * 1000,
    );
    expect(got).toEqual(payload);
  });

  it("無快取且下載失敗時回傳 undefined", async () => {
    const path = join(dir(), "none.json");
    const got = await loadCatalog(path, async () => {
      throw new Error("offline");
    });
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

describe("limits / loadCatalog 快取驗證與投影", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "limits-"));
  const payload = { anthropic: { models: { "claude-x": { limit: { context: 1, output: 2 } } } } };
  const fresh = () => 1000;

  it("新鮮但形狀損毀的快取會重新下載，不採用損毀內容", async () => {
    const path = join(dir(), "c.json");
    await Bun.write(path, JSON.stringify({ fetchedAt: 1000, catalog: { anthropic: "損毀" } }));
    let calls = 0;
    const got = await loadCatalog(
      path,
      async () => {
        calls += 1;
        return new Response(JSON.stringify(payload));
      },
      fresh,
    );
    expect(calls).toBe(1);
    expect(got).toEqual(payload);
  });

  it("時間戳在未來（時鐘倒退）視為不新鮮，重新下載", async () => {
    const path = join(dir(), "c.json");
    await Bun.write(path, JSON.stringify({ fetchedAt: 5000, catalog: {} }));
    const got = await loadCatalog(
      path,
      async () => new Response(JSON.stringify(payload)),
      () => 1000,
    );
    expect(got).toEqual(payload);
  });

  it("下載內容形狀不合（無任何官方來源）時保留既有有效快取，不覆寫", async () => {
    const path = join(dir(), "c.json");
    const stale = JSON.stringify({ fetchedAt: 0, catalog: payload });
    await Bun.write(path, stale);
    const got = await loadCatalog(
      path,
      async () => new Response(JSON.stringify({ neon: { models: {} } })),
      () => 25 * 60 * 60 * 1000,
    );
    expect(got).toEqual(payload);
    expect(await Bun.file(path).text()).toBe(stale);
  });

  it("下載的非 JSON 內容視為失敗，保留既有快取", async () => {
    const path = join(dir(), "c.json");
    await Bun.write(path, JSON.stringify({ fetchedAt: 0, catalog: payload }));
    const got = await loadCatalog(
      path,
      async () => new Response("<html>maintenance</html>"),
      () => 25 * 60 * 60 * 1000,
    );
    expect(got).toEqual(payload);
  });

  it("寫回的快取只含官方來源與完整上限，不鏡像整份目錄", async () => {
    const path = join(dir(), "c.json");
    const big = {
      anthropic: {
        models: {
          "claude-x": { limit: { context: 1, output: 2 }, name: "x", cost: { input: 3 } },
          "claude-no-output": { limit: { context: 9 } },
        },
      },
      neon: { models: { "claude-x": { limit: { context: 7, output: 8 } } } },
    };
    await loadCatalog(path, async () => new Response(JSON.stringify(big)), fresh);
    const saved = await Bun.file(path).json();
    expect(Object.keys(saved.catalog)).toEqual(["anthropic"]);
    expect(saved.catalog.anthropic).toEqual({ models: { "claude-x": { limit: { context: 1, output: 2 } } } });
  });

  it("舊版完整目錄快取（含非官方來源與不合格條目）投影後仍可用，下載失敗時不遺失", async () => {
    const legacy = {
      fetchedAt: 0,
      catalog: {
        anthropic: {
          id: "anthropic",
          models: {
            "claude-x": { id: "claude-x", limit: { context: 1, output: 2 }, cost: { input: 3 } },
            broken: { limit: { context: 0, output: 5 } },
            nolimit: { name: "n" },
          },
        },
        neon: { models: {} },
        odd: "not-an-object",
      },
    };
    const expected = { anthropic: { models: { "claude-x": { limit: { context: 1, output: 2 } } } } };

    const stalePath = join(dir(), "stale.json");
    await Bun.write(stalePath, JSON.stringify(legacy));
    const offline = async () => {
      throw new Error("offline");
    };
    expect(await loadCatalog(stalePath, offline, () => 25 * 60 * 60 * 1000)).toEqual(expected);

    const freshPath = join(dir(), "fresh.json");
    await Bun.write(freshPath, JSON.stringify({ ...legacy, fetchedAt: 1000 }));
    let calls = 0;
    expect(
      await loadCatalog(
        freshPath,
        async () => {
          calls += 1;
          return new Response("{}");
        },
        () => 1000,
      ),
    ).toEqual(expected);
    expect(calls).toBe(0);
  });

  it("單一條目不合格只略過該條目，其餘條目仍可查", async () => {
    const path = join(dir(), "none.json");
    const got = await loadCatalog(
      path,
      async () =>
        new Response(
          JSON.stringify({
            anthropic: {
              models: {
                bad: { limit: { context: -1, output: 2 } },
                noOutput: { limit: { context: 2 } },
                good: { limit: { context: 3, output: 4 } },
              },
            },
          }),
        ),
      fresh,
    );
    expect(got).toEqual({ anthropic: { models: { good: { limit: { context: 3, output: 4 } } } } });
    expect(lookupLimit(got!, "anthropic/noOutput")).toBeUndefined();
  });
});
