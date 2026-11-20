/**
 * @fileoverview 401 回應的登入狀態判定，決定 Magpie 的 X-Magpie-Sign-In 標頭。
 * Magpie 對沒有此標頭的 401 會把帳號標記為需要重新登入，因此無法判定時也必須明確送 kept，不能留白。
 * 規格出處：Magpie 外掛規範 https://usemagpie.ai/docs/plugins（Sign-in state）；
 * LiteLLM 錯誤代碼 https://docs.litellm.ai/docs/proxy/error_reference
 */

import { isRecord, parseJsonRecord } from "./json.js";

export const SIGN_IN_HEADER = "X-Magpie-Sign-In";

/** 送給 Magpie 的登入狀態；只有 expired 會標記帳號 */
export enum SignInState {
  EXPIRED = "expired",
  KEPT = "kept",
}

/** 401 內文的三種判定結果 */
export enum UnauthorizedOutcome {
  /** 確認是 key／token 失效或過期 */
  KEY_FAILURE = "key_failure",
  /** 確認只是某個模型不可用，登入本身沒問題 */
  MODEL_SPECIFIC = "model_specific",
  /** 內文不足以判定（空、不可讀、逾時、過大、或同時有模型與 key 的訊息） */
  UNDETERMINED = "undetermined",
}

/** LiteLLM 閘道層級、確認代表 key 本身失效的錯誤類型（auth_error 是兜底類型，預算預扣失敗也會用它，不能列入） */
const KEY_FAILURE_TYPES = new Set(["token_not_found_in_db", "expired_key"]);
/** 上游供應商的 <Provider>Exception 訊息：是部署上的憑證被拒，不是使用者的登入，不得標記 */
const UPSTREAM_ORIGIN = /\b[A-Za-z]+Exception\s+-/;
/** 明確說 token／key／session／sign-in 無效、過期或被封鎖 */
const INVALID_KEY_WORDING =
  /\b(?:invalid|expired|blocked)\b[^.\n]{0,60}\b(?:token|api[ _-]?key|key|session|sign[ -]?in)\b|\b(?:token|api[ _-]?key|key|session|sign[ -]?in)\b[^.\n]{0,60}\b(?:invalid|expired|blocked)\b/i;
/** 只說模型不被提供（model_not_found、model … not available、模型不支持） */
const MODEL_SPECIFIC_WORDING = /model_not_found|model[^.\n]{0,80}not available|模型不支持/i;

/**
 * 依 401 內文判定結果。內文為 undefined（讀取失敗或超出界線）時視為無法判定。
 * 優先序：key 類型 > 上游供應商錯誤（視為無法判定）> key 失效字樣 > 模型字樣 > 無法判定。
 *
 * @example
 * classifyUnauthorized('{"error":{"type":"expired_key"}}'); // UnauthorizedOutcome.KEY_FAILURE
 * classifyUnauthorized('{"error":"model_not_found"}'); // UnauthorizedOutcome.MODEL_SPECIFIC
 *
 * @param text - 有界讀取後的 401 內文，JSON 或純文字皆可
 */
export function classifyUnauthorized(text: string | undefined): UnauthorizedOutcome {
  if (text === undefined) return UnauthorizedOutcome.UNDETERMINED;

  const error = parseJsonRecord(text)?.error;
  const message =
    typeof error === "string" ? error : isRecord(error) && typeof error.message === "string" ? error.message : text;
  const types = isRecord(error) ? [error.type, error.litellm_error_type] : [];

  if (types.some((type) => typeof type === "string" && KEY_FAILURE_TYPES.has(type))) {
    return UnauthorizedOutcome.KEY_FAILURE;
  }
  if (UPSTREAM_ORIGIN.test(message)) return UnauthorizedOutcome.UNDETERMINED;
  if (INVALID_KEY_WORDING.test(message)) return UnauthorizedOutcome.KEY_FAILURE;
  if (MODEL_SPECIFIC_WORDING.test(message)) return UnauthorizedOutcome.MODEL_SPECIFIC;
  return UnauthorizedOutcome.UNDETERMINED;
}

/**
 * 判定結果轉為 Magpie 登入狀態：只有確認的 key 失效才 expired，其餘一律 kept
 *
 * @example
 * signInStateFor(UnauthorizedOutcome.UNDETERMINED); // SignInState.KEPT
 */
export function signInStateFor(outcome: UnauthorizedOutcome): SignInState {
  return outcome === UnauthorizedOutcome.KEY_FAILURE ? SignInState.EXPIRED : SignInState.KEPT;
}
