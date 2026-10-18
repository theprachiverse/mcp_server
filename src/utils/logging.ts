import { createHash } from "node:crypto";

export type LogLevel = "error" | "warn" | "info" | "debug";
const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const SENSITIVE_SUBSTRINGS = ["token", "secret", "authorization", "password", "cookie"];
const SENSITIVE_EXACT = new Set([
  "raw",
  "body",
  "text",
  "heading",
  "subject",
  "to",
  "cc",
  "bcc",
  "reply_to",
  "replyto",
  "requestbody",
  "data",
  "headers",
  "config",
  "request",
  "response",
]);
const TOKEN_PATTERNS: RegExp[] = [
  /ya29\.[\w.-]+/g,
  /1\/\/[\w.-]{10,}/g,
  /GOCSPX-[\w-]+/g,
  /Bearer\s+[\w.~+/=-]+/gi,
];

export function maskString(s: string): string {
  let out = s;
  for (const p of TOKEN_PATTERNS) out = out.replace(p, "[REDACTED]");
  return out;
}

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_EXACT.has(k) || SENSITIVE_SUBSTRINGS.some((s) => k.includes(s));
}

/** Deep copy with sensitive keys replaced and token-like strings masked. */
export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") return maskString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value) || depth > 6) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: maskString(value.message) };
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") out.code = code;
    const status = (value as { status?: unknown }).status;
    if (typeof status === "number") out.status = status;
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? "[REDACTED]" : redact(v, seen, depth + 1);
  }
  return out;
}

/** Short stable hash so documents can be correlated in logs without exposing their IDs. */
export function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

export interface Logger {
  error(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(opts: {
  level: LogLevel;
  stream?: { write(chunk: string): unknown };
}): Logger {
  const stream = opts.stream ?? process.stderr;
  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] > ORDER[opts.level]) return;
    const record = { ts: new Date().toISOString(), level, event, ...(redact(fields) as object) };
    stream.write(JSON.stringify(record) + "\n");
  };
  return {
    error: (e, f) => emit("error", e, f),
    warn: (e, f) => emit("warn", e, f),
    info: (e, f) => emit("info", e, f),
    debug: (e, f) => emit("debug", e, f),
  };
}

export const nullLogger: Logger = { error() {}, warn() {}, info() {}, debug() {} };
