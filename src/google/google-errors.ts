import { AppError } from "../utils/errors.js";
import { parseRetryAfter } from "../utils/retry.js";

export interface GoogleErrorInfo {
  status?: number;
  reason?: string;
  statusText?: string;
  oauthError?: string;
  nodeCode?: string;
  message: string;
}

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Pulls the useful, non-sensitive signals out of a gaxios / google-auth-library error. */
export function extractGoogleErrorInfo(err: unknown): GoogleErrorInfo {
  const e = (err ?? {}) as Loose;
  const data = e.response?.data ?? e.data;
  const apiError = data && typeof data === "object" ? data.error : undefined;
  const rawStatus =
    e.response?.status ?? e.status ?? (typeof e.code === "number" ? e.code : undefined);
  const numericCode =
    typeof e.code === "string" && /^\d{3}$/.test(e.code) ? Number(e.code) : undefined;
  const status = typeof rawStatus === "number" ? rawStatus : (numericCode ?? apiError?.code);
  const info: GoogleErrorInfo = {
    message: typeof e.message === "string" ? e.message : "",
  };
  if (typeof status === "number") info.status = status;
  const reason = apiError?.errors?.[0]?.reason ?? e.errors?.[0]?.reason;
  if (typeof reason === "string") info.reason = reason;
  if (typeof apiError?.status === "string") info.statusText = apiError.status;
  if (typeof data?.error === "string") info.oauthError = data.error;
  if (typeof e.code === "string" && !/^\d{3}$/.test(e.code)) info.nodeCode = e.code;
  return info;
}

const NEVER_DELIVERED = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
const AMBIGUOUS_NODE = new Set([
  "ETIMEDOUT",
  "ECONNABORTED",
  "ECONNRESET",
  "EPIPE",
  "ABORT_ERR",
  "UND_ERR_SOCKET",
]);

/** The request definitely never reached Google (DNS failure, connection refused). */
export function wasNeverDelivered(err: unknown): boolean {
  const { nodeCode } = extractGoogleErrorInfo(err);
  return nodeCode !== undefined && NEVER_DELIVERED.has(nodeCode);
}

function looksLikeTimeout(err: unknown, info: GoogleErrorInfo): boolean {
  const name = (err as Loose | null)?.name;
  return (
    name === "AbortError" || name === "TimeoutError" || /time(d)?\s?out|aborted/i.test(info.message)
  );
}

/** A write whose result we cannot know: timeout, reset connection or Google 5xx. */
export function isAmbiguousWriteFailure(err: unknown): boolean {
  if (err instanceof AppError) return false;
  const info = extractGoogleErrorInfo(err);
  if (info.status !== undefined) return info.status >= 500;
  if (info.nodeCode !== undefined) return AMBIGUOUS_NODE.has(info.nodeCode);
  return looksLikeTimeout(err, info);
}

/** Docs rejected a batchUpdate because the document changed since we read it (nothing written). */
export function isRevisionMismatch(err: unknown): boolean {
  const info = extractGoogleErrorInfo(err);
  if (info.status !== 400 && info.status !== 409 && info.status !== 412) return false;
  return info.statusText === "FAILED_PRECONDITION" || /revision/i.test(info.message);
}

/** Whether a failed read is worth repeating (reads have no side effects). */
export function isRetryableRead(err: unknown): boolean {
  if (err instanceof AppError) return false;
  const info = extractGoogleErrorInfo(err);
  if (info.status !== undefined) return info.status === 429 || info.status >= 500;
  if (info.nodeCode !== undefined) {
    return NEVER_DELIVERED.has(info.nodeCode) || AMBIGUOUS_NODE.has(info.nodeCode);
  }
  return looksLikeTimeout(err, info);
}

export function retryAfterMsFromError(err: unknown): number | undefined {
  const headers = ((err ?? {}) as Loose).response?.headers;
  if (!headers) return undefined;
  const value =
    typeof headers.get === "function" ? headers.get("retry-after") : headers["retry-after"];
  return parseRetryAfter(value);
}

const QUOTA_REASONS = new Set(["dailyLimitExceeded", "quotaExceeded", "RESOURCE_EXHAUSTED"]);
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"]);

/**
 * Maps a Google/library error to an AppError with a fixed, safe message.
 * `kind: "write"`: a 5xx or timeout becomes OPERATION_OUTCOME_UNKNOWN.
 */
export function mapGoogleError(err: unknown, opts: { kind: "read" | "write" }): AppError {
  if (err instanceof AppError) return err;
  const info = extractGoogleErrorInfo(err);
  const cause = err;

  if (info.oauthError === "invalid_grant" || /invalid_grant/.test(info.message)) {
    return new AppError("AUTH_EXPIRED", undefined, { cause });
  }
  if (wasNeverDelivered(err)) {
    return new AppError("NETWORK_ERROR", undefined, { cause, retryable: true });
  }

  const { status, reason, statusText } = info;
  if (status === 401) return new AppError("AUTH_EXPIRED", undefined, { cause });
  if (status === 429 || (reason && RATE_REASONS.has(reason))) {
    return new AppError("RATE_LIMITED", undefined, { cause, retryable: true });
  }
  if ((reason && QUOTA_REASONS.has(reason)) || statusText === "RESOURCE_EXHAUSTED") {
    return new AppError("QUOTA_EXCEEDED", undefined, { cause });
  }
  if (status === 403) {
    if (reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") {
      return new AppError(
        "AUTH_REQUIRED",
        "The saved Google authorization lacks a required permission. Run `npm run auth` again and approve all requested access.",
        { cause },
      );
    }
    return new AppError(
      "PERMISSION_DENIED",
      "The authenticated Google account does not have permission for this action. Check that it can edit the document or that the API is enabled.",
      { cause },
    );
  }
  if (status === 404) {
    return new AppError(
      "RESOURCE_NOT_FOUND",
      "The document was not found or is not accessible to the authenticated account. Only existing Google Docs are supported.",
      { cause },
    );
  }
  if (status === 400) {
    if (/not\s+a\s+document|not\s+supported|unsupported/i.test(info.message)) {
      return new AppError(
        "RESOURCE_NOT_FOUND",
        "The ID does not refer to a Google Doc. Only existing Google Docs are supported.",
        { cause },
      );
    }
    return new AppError("INVALID_ARGUMENT", "Google rejected the request as invalid.", { cause });
  }

  const ambiguous = isAmbiguousWriteFailure(err);
  if (opts.kind === "write" && ambiguous) {
    return new AppError("OPERATION_OUTCOME_UNKNOWN", undefined, { cause });
  }
  if (ambiguous) {
    return new AppError("NETWORK_ERROR", undefined, { cause, retryable: true });
  }
  if (status !== undefined) {
    return new AppError("GOOGLE_API_ERROR", undefined, { cause, retryable: opts.kind === "read" });
  }
  return new AppError("INTERNAL_ERROR", undefined, { cause });
}
