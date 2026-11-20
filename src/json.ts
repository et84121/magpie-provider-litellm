/**
 * @fileoverview 診斷內文共用的 JSON 小工具
 */

/**
 * 判斷值是否為普通 JSON 物件（排除 null 與陣列）
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 JSON 物件內文，失敗或頂層不是物件時回傳 undefined
 */
export function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
