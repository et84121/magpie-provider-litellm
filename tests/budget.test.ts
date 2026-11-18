/**
 * @fileoverview 測試 LiteLLM 多層級預算探測邏輯
 * 回應形狀依 2026-11 實機 /key/info、/user/info、/team/info 回傳與 LiteLLM 原始碼整理，已去除識別資料。
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatPeriod, parseDurationToSeconds, queryLiteLLMBudget } from "../src/budget.js";

const STATUS = Symbol("status");
type HttpError = { [STATUS]: number; body: unknown };

/** 非 2xx 回應，但 body 仍是結構正確的 JSON：用來確認呼叫端看的是狀態碼，而不是 body 的形狀 */
function httpError(status: number, body: unknown = {}): HttpError {
  return { [STATUS]: status, body };
}

function isHttpError(value: unknown): value is HttpError {
  return typeof value === "object" && value !== null && STATUS in value;
}

/** 依 URL 路徑回傳預先設定的回應；未設定的路徑回 404，設為 "error" 則模擬網路失敗 */
function mockLiteLLM(routes: Record<string, unknown>) {
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const reply = routes[url.pathname];
    if (reply === "error") throw new Error("network down");
    if (reply === undefined) return new Response("Not found", { status: 404 });
    if (isHttpError(reply)) return new Response(JSON.stringify(reply.body), { status: reply[STATUS] });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as any;
}

/** 讀取脫敏後的實機 fixture（見 tests/fixtures/README.md），每次回傳新物件，測試可安心修改 */
const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("budget / parseDurationToSeconds", () => {
  it("正確將天數、小時、分鐘、秒轉換為秒數", () => {
    expect(parseDurationToSeconds("30d")).toBe(30 * 86400);
    expect(parseDurationToSeconds("7d")).toBe(7 * 86400);
    expect(parseDurationToSeconds("24h")).toBe(24 * 3600);
    expect(parseDurationToSeconds("60m")).toBe(3600);
    expect(parseDurationToSeconds("30s")).toBe(30);
    expect(parseDurationToSeconds(undefined)).toBeUndefined();
    expect(parseDurationToSeconds("invalid")).toBeUndefined();
  });
});

describe("budget / formatPeriod", () => {
  it("把 LiteLLM 週期轉為中文", () => {
    expect(formatPeriod("1h")).toBe("每小時");
    expect(formatPeriod("24h")).toBe("每日");
    expect(formatPeriod("1d")).toBe("每日");
    expect(formatPeriod("7d")).toBe("每週");
    expect(formatPeriod("30d")).toBe("每月");
    expect(formatPeriod("1mo")).toBe("每月");
    expect(formatPeriod("12mo")).toBe("每年");
    expect(formatPeriod("45m")).toBe("每 45m");
    expect(formatPeriod(null)).toBe("");
  });
});

describe("budget / queryLiteLLMBudget", () => {
  it("團隊金鑰：Key 的 7d 上限會計入剩餘額度，User 的 30d 上限不計入（個人預算不適用於團隊金鑰）", async () => {
    mockLiteLLM({
      "/key/info": {
        info: {
          spend: 38.08,
          max_budget: 100,
          budget_duration: "7d",
          budget_reset_at: "2026-11-23T00:00:00+00:00",
          user_id: "u-1",
          team_id: "t-1",
        },
      },
      "/user/info": {
        user_info: { spend: 99.67, max_budget: 200, budget_duration: "30d", budget_reset_at: "2026-12-01T00:00:00Z" },
      },
      "/team/info": { team_info: { spend: 238.7, max_budget: 2000, budget_duration: "30d" }, team_memberships: [] },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");

    const key = usage.windows.find((w) => w.name === "Key · 每週")!;
    expect(key.limit).toBe(100);
    expect(key.amount).toBe(38.08);
    expect(key.used).toBe(38);
    expect(key.resetsAt).toBe("2026-11-23T00:00:00.000Z");
    expect(key.span).toBe(7 * 86400);
    expect(key.aside).toBeUndefined();

    const user = usage.windows.find((w) => w.name.startsWith("User · 每月"))!;
    expect(user.name).toBe("User · 每月（團隊金鑰不計）");
    expect(user.used).toBeUndefined();
    expect(user.aside).toBe(true);

    // 有上限的 Key 旁邊的累計花費列：同樣只給 display
    const cumulative = usage.windows.find((w) => w.name === "Key 累計花費")!;
    expect(cumulative.amount).toBeUndefined();
    expect(cumulative.aside).toBe(true);

    const team = usage.windows.find((w) => w.name === "Team · 每月")!;
    expect(team.limit).toBe(2000);

    // 會擋的 Key 排在前面，剩餘額度以它為準
    expect(usage.windows[0].name).toBe("Key · 每週");
    expect(usage.balance).toBe("$61.92（Key · 每週）");
    expect(usage.user).toBe("u-1");
  });

  it("個人金鑰（無 team_id）：User 上限會擋，計入剩餘額度", async () => {
    mockLiteLLM({
      "/key/info": { info: { spend: 73.35, max_budget: null, user_id: "alice@example.com", team_id: null } },
      "/user/info": {
        user_info: { spend: 73.35, max_budget: 500, budget_duration: "30d", budget_reset_at: "2026-12-01T00:00:00Z" },
      },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");

    const user = usage.windows.find((w) => w.name === "User · 每月")!;
    expect(user.used).toBe(15);
    expect(user.display).toBe("$73.35 / $500.00");
    expect(usage.balance).toBe("$426.65（User · 每月）");
  });

  it("多視窗 budget_limits：每個視窗各一條，用量來自 budget_limits_usage", async () => {
    mockLiteLLM({
      "/key/info": {
        info: {
          spend: 12,
          max_budget: null,
          user_id: "u",
          team_id: null,
          budget_limits: [
            { budget_duration: "24h", max_budget: 10, reset_at: "2026-11-19T00:00:00+00:00" },
            { budget_duration: "30d", max_budget: 100, reset_at: "2026-12-01T00:00:00+00:00" },
          ],
          budget_limits_usage: { "24h": { current_spend: 4 }, "30d": { current_spend: 12 } },
        },
      },
      "/user/info": { user_info: { spend: 0 } },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");

    const daily = usage.windows.find((w) => w.name === "Key · 每日")!;
    expect(daily.amount).toBe(4);
    expect(daily.limit).toBe(10);
    expect(daily.used).toBe(40);
    expect(daily.resetsAt).toBe("2026-11-19T00:00:00.000Z");
    expect(daily.span).toBe(86400);

    const monthly = usage.windows.find((w) => w.name === "Key · 每月")!;
    expect(monthly.used).toBe(12);

    // 最緊的是每日（剩 $6），即使月度用量百分比較低也不影響
    expect(usage.balance).toBe("$6.00（Key · 每日）");
  });

  it("多視窗但用量讀不到：照實標示上限，剩餘額度以上限為上界並標示「最多」", async () => {
    mockLiteLLM({
      "/key/info": {
        info: {
          spend: 0,
          user_id: "u",
          budget_limits: [{ budget_duration: "1h", max_budget: 1 }],
          budget_limits_usage: null,
        },
      },
      "/user/info": { user_info: { spend: 0 } },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");
    const hourly = usage.windows.find((w) => w.name === "Key · 每小時")!;
    expect(hourly.display).toBe("$1.00 上限（用量未取得）");
    expect(hourly.used).toBeUndefined();
    expect(usage.balance).toBe("最多 $1.00（Key · 每小時，用量未取得）");
  });

  it("per-model 預算：合併成一條字串摘要，不展開成多條視窗", async () => {
    mockLiteLLM({
      "/key/info": {
        info: {
          spend: 5,
          user_id: "u",
          model_max_budget_usage: {
            "claude-opus-5": { current_spend: 3.5, budget_limit: 200, time_period: "1mo" },
            "gpt-6-luna": { current_spend: 0, budget_limit: 10, time_period: "1d" },
          },
        },
      },
      "/user/info": { user_info: { spend: 0 } },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");

    const modelWindows = usage.windows.filter((w) => w.name === "模型額度");
    expect(modelWindows.length).toBe(1);
    expect(modelWindows[0].display).toContain("Key · claude-opus-5 $200.00 每月（已用 $3.50）");
    expect(modelWindows[0].display).toContain("Key · gpt-6-luna $10.00 每日（已用 $0.00）");
    // 沒有任何上限層的 key 只剩累計花費，不應被 per-model 字串影響剩餘額度
    expect(usage.balance).toBe("$5.00 spent");
  });

  it("無上限的 key 只顯示累計花費（週期有設定時標示週期）", async () => {
    mockLiteLLM({
      "/key/info": {
        info: { spend: 50, max_budget: null, budget_duration: "30d", user_id: "bob", team_id: null },
      },
      "/user/info": { user_info: { spend: 50, max_budget: null } },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");

    const keyOnly = usage.windows.find((w) => w.name === "Key · 每月 花費")!;
    expect(keyOnly.display).toBe("$50.00");
    // 沒有上限可算比例：只給 display，不給 amount，Magpie 才不會顯示誤導的百分比
    expect(keyOnly.amount).toBeUndefined();
    expect(keyOnly.aside).toBe(true);
    expect(usage.windows.find((w) => w.name === "User 每月 花費")).toBeUndefined();
    expect(usage.windows.find((w) => w.name === "User 累計花費")).toBeDefined();
    expect(usage.balance).toBe("$50.00 spent");
  });

  it("budget_limits 沒有任何有效上限時，仍顯示 Key 的花費", async () => {
    mockLiteLLM({
      "/key/info": {
        info: {
          spend: 12,
          max_budget: null,
          user_id: null,
          team_id: null,
          budget_limits: [{ budget_duration: "24h", max_budget: null }],
        },
      },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");
    expect(usage.windows.some((w) => w.used !== undefined || w.name.startsWith("Key · 每日"))).toBe(false);
    expect(usage.windows.find((w) => w.name === "Key 累計花費")?.display).toBe("$12.00");
    expect(usage.balance).toBe("$12.00 spent");
  });

  it("Team 成員：僅在 team_memberships 找到該使用者的成員預算時顯示", async () => {
    mockLiteLLM({
      "/key/info": { info: { spend: 10, user_id: "member-1", team_id: "t-1" } },
      "/team/info": {
        team_info: { spend: 100, max_budget: null },
        team_memberships: [
          { user_id: "other", spend: 0, litellm_budget_table: { max_budget: 50, budget_duration: "30d" } },
          {
            user_id: "member-1",
            spend: 10,
            litellm_budget_table: { max_budget: 50, budget_duration: "30d", budget_reset_at: "2026-12-01T00:00:00Z" },
          },
        ],
      },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");

    const member = usage.windows.find((w) => w.name === "Team 成員 · 每月")!;
    expect(member.limit).toBe(50);
    expect(member.amount).toBe(10);
    expect(usage.balance).toBe("$40.00（Team 成員 · 每月）");
  });

  it("Team 成員：找不到該使用者的成員預算時不顯示此層", async () => {
    mockLiteLLM({
      "/key/info": { info: { spend: 10, user_id: "member-1", team_id: "t-1" } },
      "/team/info": { team_info: { spend: 100 }, team_memberships: [] },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");
    expect(usage.windows.some((w) => w.name.startsWith("Team 成員"))).toBe(false);
  });

  it("團隊預設成員上限：成員沒有個別上限時套用 team_member_budget（對齊 LiteLLM）", async () => {
    mockLiteLLM({
      "/key/info": { info: { spend: 10, user_id: "member-9", team_id: "t-1" } },
      "/team/info": {
        team_info: { spend: 100, max_budget: null, team_member_budget: 30, team_member_budget_duration: "30d" },
        team_memberships: [],
      },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");

    const member = usage.windows.find((w) => w.name === "Team 成員 · 每月")!;
    expect(member.limit).toBe(30);
    expect(member.amount).toBe(0);
    expect(usage.balance).toBe("$30.00（Team 成員 · 每月）");
  });

  it("成員個別上限優先於團隊預設", async () => {
    mockLiteLLM({
      "/key/info": { info: { spend: 5, user_id: "member-9", team_id: "t-1" } },
      "/team/info": {
        team_info: { spend: 100, max_budget: null, team_member_budget: 30, team_member_budget_duration: "30d" },
        team_memberships: [
          { user_id: "member-9", spend: 5, litellm_budget_table: { max_budget: 50, budget_duration: "30d" } },
        ],
      },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");

    const member = usage.windows.find((w) => w.name === "Team 成員 · 每月")!;
    expect(member.limit).toBe(50);
    expect(member.amount).toBe(5);
  });

  it("降級：user/info 與 team/info 失敗時，仍回傳 key 層，並列出讀取失敗的團隊層", async () => {
    mockLiteLLM({
      "/key/info": {
        info: { spend: 38.08, max_budget: 100, budget_duration: "7d", user_id: "u", team_id: "t" },
      },
      "/user/info": "error",
      // 非 2xx 但 body 結構正確：若呼叫端不檢查狀態碼，團隊上限會被誤讀進來
      "/team/info": httpError(403, { team_info: { spend: 238.7, max_budget: 2000, budget_duration: "30d" } }),
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");
    const names = usage.windows.map((w) => w.name);
    expect(names).toContain("Key · 每週");
    expect(names).toContain("Team（讀取失敗）");
    expect(names).not.toContain("Team · 每月");
    expect(names).not.toContain("User（讀取失敗）");
    // 團隊強制上限可能存在，剩餘額度只能是上界
    expect(usage.balance).toBe("最多 $61.92（Key · 每週）");
    expect(usage.error).toBeUndefined();
  });

  it("團隊金鑰的 User 層讀取失敗不影響剩餘額度（該層本來就不計入）", async () => {
    mockLiteLLM({
      "/key/info": {
        info: { spend: 38.08, max_budget: 100, budget_duration: "7d", user_id: "u", team_id: "t" },
      },
      "/user/info": "error",
      "/team/info": { team_info: { spend: 10, max_budget: null }, team_memberships: [] },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");
    expect(usage.windows.some((w) => w.name === "User（讀取失敗）")).toBe(false);
    expect(usage.balance).toBe("$61.92（Key · 每週）");
  });

  it("key/info 失敗時回傳 error，而不是假裝有花費", async () => {
    mockLiteLLM({ "/key/info": httpError(401, { info: { spend: 999, max_budget: 1 } }) });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "bad");
    expect(usage.windows).toEqual([]);
    expect(usage.error).toBe("無法取得 LiteLLM 金鑰資訊");
  });

  it("預算上限為 0 或 null 視為無上限，不產生進度條", async () => {
    mockLiteLLM({
      "/key/info": { info: { spend: 1, max_budget: 0, user_id: "u", team_id: null } },
      "/user/info": { user_info: { spend: 1, max_budget: 0, budget_duration: "30d" } },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");
    expect(usage.windows.some((w) => w.used !== undefined)).toBe(false);
    expect(usage.balance).toBe("$1.00 spent");
  });

  it("剩餘額度取剩餘金額最少者，而非用量百分比最高者", async () => {
    mockLiteLLM({
      "/key/info": {
        info: {
          spend: 8,
          user_id: "u",
          team_id: null,
          budget_limits: [{ budget_duration: "24h", max_budget: 10 }],
          budget_limits_usage: { "24h": { current_spend: 8 } },
        },
      },
      // 個人預算用量 85%（比 Key 的 80% 高），但只剩 $150；Key 24h 只剩 $2，先擋住請求
      "/user/info": { user_info: { spend: 850, max_budget: 1000, budget_duration: "30d" } },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");
    expect(usage.windows[0].name).toBe("User · 每月");
    expect(usage.balance).toBe("$2.00（Key · 每日）");
  });

  it("團隊金鑰下，User 層的模型上限不列入模型額度，Key 層的仍列出", async () => {
    mockLiteLLM({
      "/key/info": {
        info: {
          spend: 0,
          user_id: "u",
          team_id: "t",
          model_max_budget_usage: { "gpt-x": { current_spend: 1, budget_limit: 9, time_period: "1d" } },
        },
      },
      "/user/info": {
        user_info: {
          spend: 0,
          model_max_budget_usage: { "claude-y": { current_spend: 3, budget_limit: 200, time_period: "1mo" } },
        },
      },
      "/team/info": { team_info: { spend: 0, max_budget: null }, team_memberships: [] },
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");
    const modelWindow = usage.windows.find((w) => w.name === "模型額度")!;
    expect(modelWindow.display).toContain("Key · gpt-x");
    expect(modelWindow.display).not.toContain("claude-y");
  });
});

describe("budget / 實機 fixture（脫敏）", () => {
  it("團隊金鑰：Key 週上限計入剩餘額度，User 與 Team 層正確標示", async () => {
    // 測試環境：key 有 $100/7d，user 有 $200/30d，team 有 $2000/30d
    const keyInfo = fx("test-key-info.json");
    const userInfo = fx("test-user-info.json");
    const teamInfo = fx("test-team-info.json");
    // fixture 的 user_id 對應關係必須保留，否則成員情境的測試不成立
    expect(keyInfo.info.user_id).toBe(teamInfo.key_user_id);
    mockLiteLLM({
      "/key/info": keyInfo,
      "/user/info": userInfo,
      "/team/info": teamInfo,
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");

    expect(usage.windows.find((w) => w.name === "Key · 每週")?.limit).toBe(100);
    expect(usage.windows.find((w) => w.name === "Team · 每月")?.limit).toBe(2000);
    expect(usage.windows.find((w) => w.name === "User · 每月（團隊金鑰不計）")).toBeDefined();
    expect(usage.balance).toBe(`$${(100 - keyInfo.info.spend).toFixed(2)}（Key · 每週）`);
  });

  it("實機情境 A：成員在 members_with_roles 內、但 team_memberships 無紀錄，團隊無預設上限 → 不顯示成員層", async () => {
    mockLiteLLM({
      "/key/info": fx("test-key-info.json"),
      "/user/info": fx("test-user-info.json"),
      "/team/info": fx("test-team-info.json"),
    });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");
    expect(usage.windows.some((w) => w.name.startsWith("Team 成員"))).toBe(false);
  });

  it("實機情境 B：成員在 team_memberships 內但 max_budget 為 null，團隊無預設上限 → 不顯示成員層", async () => {
    const keyInfo = fx("test-key-info.json");
    keyInfo.info.user_id = "member-1";
    mockLiteLLM({ "/key/info": keyInfo, "/team/info": fx("test-team-info.json") });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");
    expect(usage.windows.some((w) => w.name.startsWith("Team 成員"))).toBe(false);
  });

  it("【合成情境】成員在 membership 內且有上限 → 顯示成員層（實機無此案例，以 fixture 注入驗證路徑）", async () => {
    const teamInfo = fx("test-team-info.json");
    const keyInfo = fx("test-key-info.json");
    // 實機情境：key 使用者（member-10）沒有 membership，這裡先確認前提再注入
    const membership = teamInfo.team_memberships.find((m: any) => m.user_id === keyInfo.info.user_id);
    expect(membership).toBeUndefined();

    // 把 members_with_roles 的第一位成員的 membership 做出一筆有上限的紀錄
    const memberId = teamInfo.team_info.members_with_roles[0].user_id;
    keyInfo.info.user_id = memberId;
    teamInfo.team_memberships = [
      { user_id: memberId, spend: 10, litellm_budget_table: { max_budget: 50, budget_duration: "30d" } },
    ];
    mockLiteLLM({ "/key/info": keyInfo, "/team/info": teamInfo });

    const usage = await queryLiteLLMBudget("http://localhost:4000", "k");
    const member = usage.windows.find((w) => w.name === "Team 成員 · 每月");
    expect(member?.limit).toBe(50);
    expect(member?.amount).toBe(10);
  });
});
