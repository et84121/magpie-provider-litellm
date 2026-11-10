/**
 * @fileoverview 測試 LiteLLM 多層級預算探測邏輯
 */

import { describe, expect, it } from "bun:test";
import { parseDurationToSeconds, queryLiteLLMBudget } from "../src/budget.js";

describe("budget / parseDurationToSeconds", () => {
  it("正確將天數、小時、分鐘轉換為秒數", () => {
    expect(parseDurationToSeconds("30d")).toBe(30 * 86400);
    expect(parseDurationToSeconds("7d")).toBe(7 * 86400);
    expect(parseDurationToSeconds("24h")).toBe(24 * 3600);
    expect(parseDurationToSeconds("60m")).toBe(3600);
    expect(parseDurationToSeconds(undefined)).toBeUndefined();
    expect(parseDurationToSeconds("invalid")).toBeUndefined();
  });
});

describe("budget / queryLiteLLMBudget", () => {
  it("當 Key 無預算但 User 層級有預算時，優先使用 User 預算並計算餘額與進度條", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes("/key/info")) {
        return new Response(
          JSON.stringify({
            info: {
              spend: 1049.78,
              max_budget: null,
              user_id: "alice@example.com",
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/user/info")) {
        return new Response(
          JSON.stringify({
            user_info: {
              user_id: "alice@example.com",
              max_budget: 500.0,
              spend: 7.04,
              budget_duration: "30d",
              budget_reset_at: "2026-12-01T00:00:00Z",
            },
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    try {
      const usage = await queryLiteLLMBudget("http://localhost:4000", "test-key");

      expect(usage.user).toBe("alice@example.com");
      // 餘額應為 $500 - $7.04 = $492.96
      expect(usage.balance).toBe("$492.96");
      expect(usage.windows.length).toBe(2);

      const monthlyWindow = usage.windows[0];
      expect(monthlyWindow.name).toBe("月度額度");
      expect(monthlyWindow.limit).toBe(500);
      expect(monthlyWindow.amount).toBe(7.04);
      expect(monthlyWindow.used).toBe(1); // 1%
      expect(monthlyWindow.resetsAt).toBe(new Date("2026-12-01T00:00:00Z").toISOString());

      const lifetimeWindow = usage.windows[1];
      expect(lifetimeWindow.name).toBe("金鑰累計花費");
      expect(lifetimeWindow.display).toBe("$1049.78");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("當 Key 與 User 皆無上限時，正常回傳累計花費", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes("/key/info")) {
        return new Response(
          JSON.stringify({
            info: {
              spend: 50.0,
              max_budget: null,
              user_id: "bob@example.com",
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/user/info")) {
        return new Response(
          JSON.stringify({
            user_info: {
              user_id: "bob@example.com",
              max_budget: null,
              spend: 50.0,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    try {
      const usage = await queryLiteLLMBudget("http://localhost:4000", "test-key");

      expect(usage.user).toBe("bob@example.com");
      expect(usage.balance).toBe("$50.00 spent");
      expect(usage.windows.length).toBe(1);
      expect(usage.windows[0].name).toBe("金鑰累計花費");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
