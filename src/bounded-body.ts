/**
 * @fileoverview 有界讀取診斷用的回應內文（429 與 401 共用）。只讀 clone 的分支，原回應的 body 保持未讀，
 * 讓成功與串流回應可以原樣交回呼叫端。
 */

/** 診斷內文的位元組上限，超過就放棄補充提示 */
export const DIAGNOSTIC_BODY_MAX_BYTES = 64 * 1024;
/** 讀取診斷內文的時間上限，超過就放棄補充提示 */
export const DIAGNOSTIC_BODY_TIMEOUT_MS = 250;
// 內文已改寫或串流重新包裝，舊的長度與編碼標頭不再對應新的 body
const STALE_BODY_HEADERS = ["content-length", "content-encoding"] as const;

/**
 * 複製回應標頭並移除過時的 content-length／content-encoding（重新包裝或改寫回應內文時共用）
 */
export function copyHeadersWithoutStaleBody(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of STALE_BODY_HEADERS) headers.delete(name);
  return headers;
}

/**
 * 有界讀取回應內文為文字。內文過大、過慢、無法讀取時回傳 undefined，由呼叫端決定如何處理原回應。
 * 不檢查 media type，由呼叫端依自己的規則判斷。
 *
 * @example
 * const text = await readBoundedText(res);
 * if (text === undefined) return res;
 */
export async function readBoundedText(res: Response): Promise<string | undefined> {
  if (Number(res.headers.get("content-length")) > DIAGNOSTIC_BODY_MAX_BYTES) return undefined;
  if (res.bodyUsed) return undefined;

  // 必須先 clone() 再碰 body：Bun 1.3.x 在「內文已整包收到」的回應上，先讀 res.body 再 clone() 會讓原 res.body 變空。
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = res.clone().body?.getReader();
  } catch {
    return undefined;
  }
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let timedOut = false;
  let bytes = 0;
  let text = "";
  // 只取消診斷用的分支。不等待 cancel：原始分支還在等外掛交回回應。
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, DIAGNOSTIC_BODY_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) return undefined;
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > DIAGNOSTIC_BODY_MAX_BYTES) return undefined;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    if (!timedOut) cancel();
    reader.releaseLock();
  }
}
