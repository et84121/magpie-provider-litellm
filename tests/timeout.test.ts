/**
 * @fileoverview 測試可清除的逾時訊號：逾時會中止，請求結束後清除則不再中止
 */

import { describe, expect, it } from "bun:test";
import { createTimeoutSignal } from "../src/timeout.js";

describe("createTimeoutSignal", () => {
  it("逾時後中止訊號", async () => {
    const timeout = createTimeoutSignal(5);
    await Bun.sleep(30);
    expect(timeout.signal.aborted).toBe(true);
    timeout.dispose();
  });

  it("請求結束後 dispose 會清除計時器，之後不再中止", async () => {
    const timeout = createTimeoutSignal(5);
    timeout.dispose();
    await Bun.sleep(30);
    expect(timeout.signal.aborted).toBe(false);
  });
});
