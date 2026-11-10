/**
 * @fileoverview LiteLLM 多層級預算探測與 Magpie Quota 轉譯
 * 支援 Key -> User -> Team 階層式探索
 */

import { cleanUrl, getManagementBase } from "./protocol.js";
import type { LiteLLMKeyInfoResponse, MagpieUsageResponse, MagpieUsageWindow } from "./types.js";

/**
 * 解析 duration 字串（例如 "30d", "7d", "24h"）為秒數
 * @private
 */
export function parseDurationToSeconds(duration?: string): number | undefined {
  if (!duration) return undefined;
  const match = String(duration).trim().match(/^(\d+)([dhms])$/i);
  if (!match) return undefined;
  const val = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "d") return val * 86400;
  if (unit === "h") return val * 3600;
  if (unit === "m") return val * 60;
  if (unit === "s") return val;
  return undefined;
}

/**
 * 查詢 LiteLLM 的多層級預算並轉換為 Magpie Usage 格式
 */
export async function queryLiteLLMBudget(
  rawBaseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<MagpieUsageResponse> {
  const rootUrl = getManagementBase(rawBaseUrl);
  const headers = { Authorization: `Bearer ${apiKey}` };

  let keySpend = 0;
  let keyMaxBudget: number | null = null;
  let keyResetAt: string | undefined = undefined;
  let userId: string | undefined = undefined;
  let teamId: string | undefined = undefined;

  // 1. 查詢 /key/info
  try {
    const res = await fetch(`${rootUrl}/key/info`, { headers, signal });
    if (res.ok) {
      const data = (await res.json()) as LiteLLMKeyInfoResponse;
      const info = data?.info;
      if (info) {
        keySpend = typeof info.spend === "number" ? info.spend : 0;
        keyMaxBudget = typeof info.max_budget === "number" && info.max_budget > 0 ? info.max_budget : null;
        keyResetAt = info.budget_reset_at ? new Date(info.budget_reset_at).toISOString() : undefined;
        userId = info.user_id;
        teamId = info.team_id;
      }
    }
  } catch {
    // 忽略暫態錯誤，繼續嘗試後續層級
  }

  // 2. 若有關聯 user_id，查詢 /user/info
  let userSpend: number | null = null;
  let userMaxBudget: number | null = null;
  let userResetAt: string | undefined = undefined;
  let userDuration: string | undefined = undefined;

  if (userId) {
    try {
      const res = await fetch(`${rootUrl}/user/info?user_id=${encodeURIComponent(userId)}`, {
        headers,
        signal,
      });
      if (res.ok) {
        const uData = (await res.json()) as any;
        const uInfo = uData?.user_info;
        if (uInfo) {
          userSpend = typeof uInfo.spend === "number" ? uInfo.spend : 0;
          userMaxBudget = typeof uInfo.max_budget === "number" && uInfo.max_budget > 0 ? uInfo.max_budget : null;
          userResetAt = uInfo.budget_reset_at ? new Date(uInfo.budget_reset_at).toISOString() : undefined;
          userDuration = uInfo.budget_duration;
        }
      }
    } catch {
      // 忽略失敗
    }
  }

  const windows: MagpieUsageWindow[] = [];

  // 決定主預算：優先使用有上限的層級（User 預算或 Key 預算）
  const activeMaxBudget = userMaxBudget ?? keyMaxBudget;
  const activeSpend = userMaxBudget !== null ? userSpend : keySpend;
  const activeResetAt = userMaxBudget !== null ? userResetAt : keyResetAt;
  const activeSpan = parseDurationToSeconds(userDuration) ?? (30 * 86400);

  let balance = `$${keySpend.toFixed(2)} spent`;

  if (activeMaxBudget !== null && activeSpend !== null) {
    const remaining = Math.max(0, activeMaxBudget - activeSpend);
    balance = `$${remaining.toFixed(2)}`;
    const usedPercent = Math.min(100, Math.round((activeSpend / activeMaxBudget) * 100));

    windows.push({
      name: userMaxBudget !== null ? "月度額度" : "金鑰額度",
      used: usedPercent,
      amount: Number(activeSpend.toFixed(2)),
      limit: Number(activeMaxBudget.toFixed(2)),
      unit: "USD",
      display: `$${activeSpend.toFixed(2)} / $${activeMaxBudget.toFixed(2)}`,
      resetsAt: activeResetAt,
      // @ts-ignore span 供 Magpie 計算週期長度
      span: activeSpan,
    });
  }

  // 若 Key 歷史累計花費與當期週期花費存在明顯差異，附加顯示歷史花費
  if (keySpend > 0 && (activeMaxBudget === null || Math.abs(keySpend - (activeSpend ?? 0)) > 0.01)) {
    windows.push({
      name: "金鑰累計花費",
      display: `$${keySpend.toFixed(2)}`,
      amount: Number(keySpend.toFixed(2)),
      // @ts-ignore aside: true 代表僅作資訊展示，不作為額度阻斷指標
      aside: true,
    });
  }

  return {
    plan: "LiteLLM Proxy",
    user: userId || "LiteLLM User",
    balance,
    windows,
  };
}
