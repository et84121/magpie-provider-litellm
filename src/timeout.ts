/**
 * @fileoverview 可清除的逾時 AbortSignal。請求結束後呼叫 dispose，計時器不會殘留到逾時時間才結束。
 */

/** 逾時訊號與其清除函式 */
export interface TimeoutSignal {
  signal: AbortSignal;
  dispose: () => void;
}

/**
 * 建立在 ms 毫秒後中止的 AbortSignal。計時器中止後自然結束；請求提早結束時呼叫 dispose 清除。
 *
 * @example
 * const timeout = createTimeoutSignal(10000);
 * try {
 *   return await fetch(url, { signal: timeout.signal });
 * } finally {
 *   timeout.dispose();
 * }
 */
export function createTimeoutSignal(ms: number): TimeoutSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}
