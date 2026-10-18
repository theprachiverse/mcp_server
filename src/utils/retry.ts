export interface RetryOptions {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  isRetryable: (err: unknown) => boolean;
  /** Returns a Retry-After hint in ms, if the error carries one. */
  retryAfterMs?: (err: unknown) => number | undefined;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter. Only use for operations that are safe to repeat. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  o: RetryOptions,
): Promise<T> {
  const sleep = o.sleep ?? defaultSleep;
  const random = o.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= o.maxAttempts || !o.isRetryable(err)) throw err;
      const ceiling = Math.min(o.maxMs, o.baseMs * 2 ** (attempt - 1));
      let delay = random() * ceiling;
      const hint = o.retryAfterMs?.(err);
      if (hint !== undefined) delay = Math.min(o.maxMs, Math.max(delay, hint));
      await sleep(delay);
    }
  }
}

/** Parses a Retry-After header value (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
