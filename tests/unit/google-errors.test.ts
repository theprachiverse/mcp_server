import { describe, expect, it } from "vitest";
import {
  isAmbiguousWriteFailure,
  isRevisionMismatch,
  mapGoogleError,
  wasNeverDelivered,
} from "../../src/google/google-errors.js";
import { AppError, type ErrorCode } from "../../src/utils/errors.js";
import { httpError, nodeError } from "../helpers/fake-docs.js";

const oauthInvalidGrant = Object.assign(new Error("invalid_grant"), {
  response: { status: 400, data: { error: "invalid_grant" } },
});

describe("mapGoogleError", () => {
  const cases: Array<[string, unknown, "read" | "write", ErrorCode]> = [
    ["400 invalid argument", httpError(400, "bad", "invalidArgument"), "write", "INVALID_ARGUMENT"],
    [
      "400 not a document",
      httpError(400, "This operation is not supported for this document"),
      "read",
      "RESOURCE_NOT_FOUND",
    ],
    ["401", httpError(401), "read", "AUTH_EXPIRED"],
    ["invalid_grant", oauthInvalidGrant, "write", "AUTH_EXPIRED"],
    [
      "403 insufficient scope",
      httpError(403, "x", "insufficientPermissions"),
      "write",
      "AUTH_REQUIRED",
    ],
    ["403 forbidden", httpError(403, "no", "forbidden"), "write", "PERMISSION_DENIED"],
    ["403 quota", httpError(403, "q", "quotaExceeded"), "write", "QUOTA_EXCEEDED"],
    ["403 daily limit", httpError(403, "q", "dailyLimitExceeded"), "read", "QUOTA_EXCEEDED"],
    ["403 rate", httpError(403, "r", "userRateLimitExceeded"), "write", "RATE_LIMITED"],
    ["429", httpError(429), "write", "RATE_LIMITED"],
    ["404", httpError(404), "read", "RESOURCE_NOT_FOUND"],
    ["ENOTFOUND (write)", nodeError("ENOTFOUND"), "write", "NETWORK_ERROR"],
    ["ECONNREFUSED (read)", nodeError("ECONNREFUSED"), "read", "NETWORK_ERROR"],
    ["500 on write", httpError(500), "write", "OPERATION_OUTCOME_UNKNOWN"],
    ["503 on read", httpError(503), "read", "NETWORK_ERROR"],
    ["ETIMEDOUT write", nodeError("ETIMEDOUT"), "write", "OPERATION_OUTCOME_UNKNOWN"],
    ["ECONNRESET write", nodeError("ECONNRESET"), "write", "OPERATION_OUTCOME_UNKNOWN"],
    [
      "timeout message",
      new Error("timeout of 20000ms exceeded"),
      "write",
      "OPERATION_OUTCOME_UNKNOWN",
    ],
    ["unknown error", new Error("kaboom"), "write", "INTERNAL_ERROR"],
    ["418 other 4xx", httpError(418), "write", "GOOGLE_API_ERROR"],
  ];
  it.each(cases)("%s", (_n, err, kind, code) => {
    expect(mapGoogleError(err, { kind }).code).toBe(code);
  });

  it("passes AppError through untouched", () => {
    const e = new AppError("AUTH_REQUIRED");
    expect(mapGoogleError(e, { kind: "write" })).toBe(e);
  });

  it("never leaks Google response text into public messages", () => {
    const err = httpError(403, "SENSITIVE-PROVIDER-DETAIL user@example.com", "forbidden");
    const mapped = mapGoogleError(err, { kind: "write" });
    expect(mapped.message).not.toContain("SENSITIVE");
    expect(mapped.message).not.toContain("user@example.com");
  });

  it("marks only delivery-less network failures and rate limits as retryable", () => {
    expect(mapGoogleError(nodeError("ENOTFOUND"), { kind: "write" }).retryable).toBe(true);
    expect(mapGoogleError(httpError(429), { kind: "write" }).retryable).toBe(true);
    expect(mapGoogleError(httpError(500), { kind: "write" }).retryable).toBe(false);
  });
});

describe("classifiers", () => {
  it("detects revision mismatch", () => {
    expect(isRevisionMismatch(httpError(400, "revision mismatch"))).toBe(true);
    expect(isRevisionMismatch(httpError(400, "x", undefined, "FAILED_PRECONDITION"))).toBe(true);
    expect(isRevisionMismatch(httpError(400, "bad index"))).toBe(false);
    expect(isRevisionMismatch(httpError(500, "revision"))).toBe(false);
  });
  it("separates never-delivered from ambiguous failures", () => {
    expect(wasNeverDelivered(nodeError("EAI_AGAIN"))).toBe(true);
    expect(wasNeverDelivered(nodeError("ECONNRESET"))).toBe(false);
    expect(isAmbiguousWriteFailure(nodeError("ECONNRESET"))).toBe(true);
    expect(isAmbiguousWriteFailure(httpError(502))).toBe(true);
    expect(isAmbiguousWriteFailure(httpError(400))).toBe(false);
    expect(isAmbiguousWriteFailure(nodeError("ENOTFOUND"))).toBe(false);
  });
});
