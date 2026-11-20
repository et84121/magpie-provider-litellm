/**
 * @fileoverview LiteLLM 429 回應的友善提示。
 * 保留原始 error.message 並附上限流說明；除失效的內文標頭外，保留回應狀態、標頭與 JSON 其他欄位。
 * 不自動重試，也不改變成功、串流或 401 等其他回應。
 * 分類依據：https://docs.litellm.ai/docs/proxy/error_reference
 * （gateway 限流以 rate_limit_type／rate_limited_by 標頭或 "Rate limit exceeded for" 前綴判定；
 * 上游供應商錯誤訊息含 <Provider>Exception；部署冷卻與預算 routing 有固定前綴）。
 */

import { copyHeadersWithoutStaleBody, readBoundedText } from "./bounded-body.js";
import { isRecord, parseJsonRecord } from "./json.js";

const HTTP_TOO_MANY_REQUESTS = 429;
const HEADER_RATE_LIMIT_TYPE = "rate_limit_type";
const HEADER_RATE_LIMITED_BY = "rate_limited_by";
const HEADER_RETRY_AFTER = "retry-after";
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json$/i;

const GATEWAY_PREFIX = "Rate limit exceeded for ";
const GATEWAY_SCOPE_IN_MESSAGE = /^Rate limit exceeded for (\w+):/;
const COOLDOWN_PREFIX = "No deployments available for selected model";
const BUDGET_ROUTING_PREFIX = "No deployments available - crossed budget";
const LIMIT_TYPE_IN_MESSAGE = /Limit type:\s*(requests|tokens|concurrent_requests)\b/;
const UPSTREAM_MESSAGE = /^(?:litellm\.RateLimitError: )?(?:RateLimitError: )?[A-Za-z][A-Za-z0-9]*Exception\s+-/;
const TPM_WORDING = /\b(?:tokens per min(?:ute)?|TPM)\b/i;
const RPM_WORDING = /\b(?:requests per min(?:ute)?|RPM)\b/i;
const TOKEN_RATE_WORDING = /\btoken (?:rate|throughput) limit\b/i;
const LIMIT_ASSERTED_AFTER =
  /^(?:\s*\((?:TPM|RPM)\))?(?:\s+(?:rate )?(?:limit|quota))?\s+(?:(?:was|is|has been)\s+)?(?:exceeded|reached|exhausted)\b/i;
const LIMIT_ASSERTED_BEFORE =
  /(?:\brate limit (?:reached|exceeded)\b.{0,160}\bon\s+|\bexceed(?:ed|s)?\s+(?:(?:your|the|this)\s+)?(?:(?:organization|account|deployment|model)(?:['’]s)?\s+)?(?:rate limit of\s+)?(?:[\d,]+\s+)?)(?:(?:input|output)\s+)?$/i;
const DELTA_SECONDS = /^\d+$/;
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/;
const ASCTIME_DATE = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) (\d{2}| \d) (\d{2}:\d{2}:\d{2}) (\d{4})$/;

/**
 * 限流的來源層級，對應 LiteLLM 文件中的 gateway、上游、部署冷卻與預算四類
 */
enum RateLimitSource {
  GATEWAY = "gateway",
  UPSTREAM = "upstream",
  COOLDOWN = "cooldown",
  BUDGET = "budget",
  UNKNOWN = "unknown",
}

/**
 * 被超過的限流維度，只有在錯誤內容有明確證據時才會標記
 */
enum RateLimitDimension {
  TPM = "tpm",
  RPM = "rpm",
  CONCURRENT = "concurrent",
  TOKEN_RATE = "token_rate",
}

interface RateLimitClassification {
  source: RateLimitSource;
  dimension: RateLimitDimension | undefined;
  scope?: string;
}

const GATEWAY_LIMIT_TYPES = new Map<string, RateLimitDimension>([
  ["requests", RateLimitDimension.RPM],
  ["tokens", RateLimitDimension.TPM],
  ["concurrent_requests", RateLimitDimension.CONCURRENT],
]);

const GATEWAY_SCOPES = new Map([
  ["api_key", "金鑰"],
  ["team", "團隊"],
  ["end_user", "終端使用者"],
  ["model_per_key", "金鑰的個別模型"],
  ["model_per_team", "團隊的個別模型"],
  ["model_per_end_user", "終端使用者的個別模型"],
  ["model_per_project", "專案的個別模型"],
]);

const DIMENSION_LABEL: Record<RateLimitDimension, string> = {
  [RateLimitDimension.TPM]: "每分鐘 Token 用量（TPM）",
  [RateLimitDimension.RPM]: "每分鐘請求數（RPM）",
  [RateLimitDimension.CONCURRENT]: "並行請求數",
  [RateLimitDimension.TOKEN_RATE]: "Token 吞吐量",
};

/**
 * 讀取可用於補充提示的 429 內文；非 JSON、過大或過慢時，不阻擋原始回應。
 * @private
 */
async function readErrorText(res: Response): Promise<string | undefined> {
  const mediaType = res.headers.get("content-type")?.split(";", 1)[0].trim();
  if (mediaType !== undefined && !JSON_MEDIA_TYPE.test(mediaType)) return undefined;
  return readBoundedText(res);
}

/**
 * 將 RFC 9110 的舊式 HTTP-date 正規化，交由標準格式驗證。
 * https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7
 * @private
 */
function normalizeHttpDate(value: string, now: number): string {
  const asctime = value.match(ASCTIME_DATE);
  if (asctime) {
    const [, weekday, month, day, time, year] = asctime;
    return `${weekday}, ${day.trim().padStart(2, "0")} ${month} ${year} ${time} GMT`;
  }

  const rfc850 = value.match(RFC850_DATE);
  if (!rfc850) return value;
  const [, weekday, day, month, shortYear, time] = rfc850;
  const latest = new Date(now);
  latest.setUTCFullYear(latest.getUTCFullYear() + 50);
  let year = Math.floor(latest.getUTCFullYear() / 100) * 100 + Number(shortYear);
  if (Date.parse(`${day} ${month} ${year} ${time} GMT`) > latest.getTime()) year -= 100;
  return `${weekday.slice(0, 3)}, ${day} ${month} ${year} ${time} GMT`;
}

/**
 * 解析 Retry-After 標頭（秒數或三種 HTTP-date），無效或已過期時不猜測等待時間。
 *
 * @example
 * parseRetryAfter("7") // 7
 * parseRetryAfter("soon") // undefined
 *
 * @param value - 原始 Retry-After 標頭值
 * @param now - 目前時間（毫秒），供 HTTP-date 換算
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (DELTA_SECONDS.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const date = normalizeHttpDate(trimmed, now);
  if (!HTTP_DATE.test(date)) return undefined;
  const at = Date.parse(date);
  if (Number.isNaN(at) || new Date(at).toUTCString() !== date) return undefined;
  const seconds = Math.ceil((at - now) / 1000);
  return seconds > 0 ? seconds : undefined;
}

/**
 * 只在同一句直接指出某種上限已被觸發時採用文字訊號，不把設定建議視為原因。
 * @private
 */
function assertsLimit(message: string, wording: RegExp): boolean {
  return message.split(/(?<!\d)\.|\.(?!\d)|[;!?\r\n]/).some((clause) => {
    const match = wording.exec(clause);
    if (!match) return false;
    return (
      LIMIT_ASSERTED_AFTER.test(clause.slice(match.index + match[0].length)) ||
      LIMIT_ASSERTED_BEFORE.test(clause.slice(0, match.index))
    );
  });
}

/**
 * 優先採用閘道回報的維度；否則只在原文指出單一維度達到上限時才補充說明。
 * @private
 */
function resolveDimension(limitType: string | undefined, message: string): RateLimitDimension | undefined {
  const fromLimitType = limitType === undefined ? undefined : GATEWAY_LIMIT_TYPES.get(limitType);
  if (fromLimitType !== undefined) return fromLimitType;
  const tokenRate = assertsLimit(message, TOKEN_RATE_WORDING);
  const tpm = assertsLimit(message, TPM_WORDING);
  if (assertsLimit(message, RPM_WORDING)) return tpm || tokenRate ? undefined : RateLimitDimension.RPM;
  if (tpm) return RateLimitDimension.TPM;
  return tokenRate ? RateLimitDimension.TOKEN_RATE : undefined;
}

/**
 * 優先採用 LiteLLM 的結構化資訊，不把原文裡的識別碼或任意標頭值帶入提示。
 * @private
 */
function classify(message: string, error: Record<string, unknown>, headers: Headers): RateLimitClassification {
  const limitType = headers.get(HEADER_RATE_LIMIT_TYPE);
  const limitedBy = headers.get(HEADER_RATE_LIMITED_BY);
  if (message.startsWith(COOLDOWN_PREFIX)) return { source: RateLimitSource.COOLDOWN, dimension: undefined };
  if (
    message.startsWith(BUDGET_ROUTING_PREFIX) ||
    limitType === "budget" ||
    error.type === "budget_exceeded" ||
    error.litellm_error_type === "budget_exceeded"
  ) {
    return { source: RateLimitSource.BUDGET, dimension: undefined };
  }

  const hasGatewayPrefix = message.startsWith(GATEWAY_PREFIX);
  if (limitType || limitedBy || hasGatewayPrefix) {
    const messageScope = message.match(GATEWAY_SCOPE_IN_MESSAGE)?.[1];
    const messageType = hasGatewayPrefix ? message.match(LIMIT_TYPE_IN_MESSAGE)?.[1] : undefined;
    const scope = limitedBy || messageScope;
    return {
      source: RateLimitSource.GATEWAY,
      dimension: resolveDimension(limitType || messageType, message),
      scope: scope ? GATEWAY_SCOPES.get(scope) : undefined,
    };
  }

  const source = UPSTREAM_MESSAGE.test(message) ? RateLimitSource.UPSTREAM : RateLimitSource.UNKNOWN;
  return { source, dimension: resolveDimension(undefined, message) };
}

/**
 * 來源層級的人話說明
 * @private
 */
function describeSource(source: RateLimitSource): string {
  switch (source) {
    case RateLimitSource.COOLDOWN:
      return "LiteLLM 部署冷卻中，模型群組內的部署暫時停用";
    case RateLimitSource.BUDGET:
      return "預算已用盡";
    case RateLimitSource.GATEWAY:
      return "LiteLLM 閘道限流";
    case RateLimitSource.UPSTREAM:
      return "上游供應商限流";
    case RateLimitSource.UNKNOWN:
      return "429 請求過多（來源未知）";
  }
}

/**
 * 組合完整提示：來源、維度與有效的等待秒數
 * @private
 */
function buildHint(classification: RateLimitClassification, retryAfter: number | undefined): string {
  const { source, scope, dimension } = classification;
  const limit = dimension === undefined ? "" : `${DIMENSION_LABEL[dimension]}已達上限`;
  const detail = [scope, limit].filter(Boolean).join(" · ");
  let wait = "";
  if (retryAfter === 0) wait = "，伺服器未要求等待";
  else if (retryAfter !== undefined) wait = `，伺服器建議 ${retryAfter} 秒後再試`;
  return `${describeSource(source)}${detail ? `：${detail}` : ""}${wait}`;
}

/**
 * 將 LiteLLM 429 回應的 error.message 改寫為帶來源與等待提示的人話版本，並保留原始訊息
 *
 * 只補充能在時間與大小上限內解析的 429 JSON；其他情況原樣轉傳。
 * 改寫後的 Response 保留 status、statusText 與所有 headers（移除過時的 content-length／content-encoding）。
 *
 * @example
 * const hinted = await enrichRateLimitResponse(res);
 *
 * @param res - 上游或 LiteLLM 回傳的 Response
 * @param now - 目前時間（毫秒），供 Retry-After 的 HTTP-date 換算
 */
export async function enrichRateLimitResponse(res: Response, now: number = Date.now()): Promise<Response> {
  if (res.status !== HTTP_TOO_MANY_REQUESTS || res.bodyUsed) return res;

  const text = await readErrorText(res);
  if (text === undefined) return res;
  const body = parseJsonRecord(text);
  const error = body?.error;
  if (body === undefined || !isRecord(error) || typeof error.message !== "string") return res;

  const message = error.message;
  const classification = classify(message, error, res.headers);
  const retryAfter = parseRetryAfter(res.headers.get(HEADER_RETRY_AFTER), now);
  // 保留原文開頭，避免破壞下游對既有限流前綴的判斷。
  const hinted = { ...body, error: { ...error, message: `${message} [${buildHint(classification, retryAfter)}]` } };

  const headers = copyHeadersWithoutStaleBody(res.headers);
  return new Response(JSON.stringify(hinted), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
