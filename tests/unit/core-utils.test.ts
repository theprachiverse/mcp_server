import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";
import { AppError, toPublicError } from "../../src/utils/errors.js";
import { createLogger, hashId, redact } from "../../src/utils/logging.js";
import { parseRetryAfter, withRetry } from "../../src/utils/retry.js";

const ROOT = path.resolve("/proj");
const baseEnv = {
  GOOGLE_OAUTH_CLIENT_ID: "id-123",
  GOOGLE_OAUTH_CLIENT_SECRET: "super-secret-value",
};

describe("errors", () => {
  it("never marks OPERATION_OUTCOME_UNKNOWN retryable", () => {
    expect(new AppError("OPERATION_OUTCOME_UNKNOWN", "x", { retryable: true }).retryable).toBe(
      false,
    );
  });
  it("hides non-AppError details", () => {
    const pub = toPublicError(new Error("secret ya29.abc"));
    expect(pub.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(pub)).not.toContain("ya29");
  });
  it("does not expose the cause", () => {
    const pub = toPublicError(
      new AppError("GOOGLE_API_ERROR", undefined, { cause: new Error("raw body") }),
    );
    expect(JSON.stringify(pub)).not.toContain("raw body");
  });
});

describe("loadConfig", () => {
  it("applies defaults and resolves the token path against the project root", () => {
    const c = loadConfig(baseEnv, ROOT);
    expect(c.redirectPort).toBe(53682);
    expect(c.gmailMaxRecipients).toBe(50);
    expect(c.tokenPath).toBe(path.resolve(ROOT, ".local/google-token.json"));
    expect(Object.isFrozen(c)).toBe(true);
  });
  it("names missing variables without values", () => {
    expect(() => loadConfig({}, ROOT)).toThrow(
      /GOOGLE_OAUTH_CLIENT_ID.*GOOGLE_OAUTH_CLIENT_SECRET/,
    );
  });
  it("rejects bad values without echoing them", () => {
    let message = "";
    try {
      loadConfig({ ...baseEnv, GMAIL_MAX_RECIPIENTS: "lots" }, ROOT);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      message = (e as Error).message;
    }
    expect(message).toContain("GMAIL_MAX_RECIPIENTS");
    expect(message).not.toContain("lots");
    expect(message).not.toContain("super-secret-value");
  });
  it("rejects an invalid time zone", () => {
    expect(() => loadConfig({ ...baseEnv, DOCS_TIMESTAMP_TIMEZONE: "Mars/Base" }, ROOT)).toThrow(
      /time zone/,
    );
  });
  it("treats empty strings as unset", () => {
    expect(loadConfig({ ...baseEnv, LOG_LEVEL: "", GMAIL_MAX_RECIPIENTS: "" }, ROOT).logLevel).toBe(
      "info",
    );
  });
});

describe("loadConfig: remote (HTTP) settings", () => {
  it("needs none of them, so stdio users are unaffected", () => {
    const c = loadConfig(baseEnv, ROOT);
    expect(c.port).toBe(3000);
    expect(c.mcpAuthToken).toBeUndefined();
    expect(c.googleTokenB64).toBeUndefined();
    expect(c.mcpAllowedHosts).toEqual([]);
    expect(c.mcpRateLimitPerMinute).toBe(30);
    expect(c.mcpTrustProxy).toBe(0);
  });
  it("merges MCP_ALLOWED_HOSTS with Railway's public domain, normalised and de-duplicated", () => {
    const c = loadConfig(
      {
        ...baseEnv,
        MCP_ALLOWED_HOSTS: " MCP.Example.com, ,other.example.com ",
        RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
      },
      ROOT,
    );
    expect(c.mcpAllowedHosts).toEqual([
      "mcp.example.com",
      "other.example.com",
      "app.up.railway.app",
    ]);
  });
  it("trusts one proxy hop on Railway unless overridden", () => {
    expect(
      loadConfig({ ...baseEnv, RAILWAY_ENVIRONMENT_NAME: "production" }, ROOT).mcpTrustProxy,
    ).toBe(1);
    expect(
      loadConfig({ ...baseEnv, RAILWAY_ENVIRONMENT_NAME: "production", MCP_TRUST_PROXY: "0" }, ROOT)
        .mcpTrustProxy,
    ).toBe(0);
  });
  it("rejects an invalid PORT without echoing it", () => {
    expect(() => loadConfig({ ...baseEnv, PORT: "not-a-port" }, ROOT)).toThrow(/PORT/);
  });
});

describe("redact / logger", () => {
  it("removes content keys and token-like strings from a realistic error", () => {
    const err = Object.assign(new Error("failed with Bearer ya29.A0AbCd-secret"), {
      config: { headers: { Authorization: "Bearer ya29.xyz" }, data: { raw: "RAWBODY" } },
      response: { status: 403, data: { refresh_token: "1//0gRefreshTokenValue123" } },
    });
    const out = JSON.stringify(
      redact({
        error: err,
        body: "Dear friend",
        to: ["a@b.com"],
        note: "token 1//0gRefreshTokenValue123",
        subject: "S",
      }),
    );
    for (const leak of ["ya29", "RAWBODY", "Dear friend", "a@b.com", "1//0g", '"S"']) {
      expect(out).not.toContain(leak);
    }
  });
  it("handles circular structures", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });
  it("respects levels and writes JSON lines", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", stream: { write: (s) => lines.push(s) } });
    log.info("x");
    log.warn("y", { n: 1 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "y", level: "warn", n: 1 });
  });
  it("hashes ids stably without containing them", () => {
    expect(hashId("abc")).toBe(hashId("abc"));
    expect(hashId("abc")).toHaveLength(12);
  });
});

describe("withRetry", () => {
  const base = { maxAttempts: 3, baseMs: 100, maxMs: 1000 };
  it("retries retryable errors with bounded jittered delays", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockResolvedValue("ok");
    await expect(
      withRetry(fn, { ...base, isRetryable: () => true, sleep, random: () => 1 }),
    ).resolves.toBe("ok");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });
  it("stops immediately for non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("no"));
    await expect(
      withRetry(fn, { ...base, isRetryable: () => false, sleep: async () => {} }),
    ).rejects.toThrow("no");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("gives up after maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await expect(
      withRetry(fn, { ...base, isRetryable: () => true, sleep: async () => {} }),
    ).rejects.toThrow("x");
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("honours Retry-After as a floor capped at maxMs", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi.fn().mockRejectedValueOnce(new Error("a")).mockResolvedValue(1);
    await withRetry(fn, {
      ...base,
      isRetryable: () => true,
      retryAfterMs: () => 5000,
      sleep,
      random: () => 0,
    });
    expect(sleep).toHaveBeenCalledWith(1000);
  });
  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(
      parseRetryAfter("Wed, 21 Oct 2015 07:28:05 GMT", Date.parse("Wed, 21 Oct 2015 07:28:00 GMT")),
    ).toBe(5000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
