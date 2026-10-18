export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "PERMISSION_DENIED",
  "RESOURCE_NOT_FOUND",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "GOOGLE_API_ERROR",
  "NETWORK_ERROR",
  "OPERATION_OUTCOME_UNKNOWN",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  INVALID_ARGUMENT: "The request arguments are invalid. Fix them and try again.",
  AUTH_REQUIRED: "Google authorization is missing. Run `npm run auth` in the server project.",
  AUTH_EXPIRED: "Google authorization expired or was revoked. Run `npm run auth` again.",
  PERMISSION_DENIED: "The authenticated Google account does not have permission for this action.",
  RESOURCE_NOT_FOUND: "The requested resource was not found or is not accessible.",
  QUOTA_EXCEEDED: "Google API quota is exhausted. Try again later.",
  RATE_LIMITED: "Google is rate limiting requests. Wait a moment and try again.",
  GOOGLE_API_ERROR: "Google returned an error. Try again later.",
  NETWORK_ERROR: "Could not reach Google. Check the network connection and try again.",
  OPERATION_OUTCOME_UNKNOWN:
    "The outcome is unknown: Google may or may not have applied the action. Check before retrying.",
  INTERNAL_ERROR: "An unexpected internal error occurred.",
};

export interface PublicError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface AppErrorOptions {
  retryable?: boolean;
  cause?: unknown;
}

/** Error whose `message` is safe to show to MCP clients. `cause` is for debug logs only. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
    super(message ?? DEFAULT_MESSAGES[code], { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    // An unknown outcome must never be marked retryable.
    this.retryable = code === "OPERATION_OUTCOME_UNKNOWN" ? false : (options.retryable ?? false);
  }
}

export function toPublicError(err: unknown): PublicError {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  return { code: "INTERNAL_ERROR", message: DEFAULT_MESSAGES.INTERNAL_ERROR, retryable: false };
}
