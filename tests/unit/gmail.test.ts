import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../../src/auth/google-oauth.js";
import type { GmailPort } from "../../src/google/clients.js";
import { GmailService } from "../../src/google/gmail-service.js";
import { createGmailSendTool } from "../../src/tools/gmail-send.js";
import { AppError } from "../../src/utils/errors.js";
import { nullLogger } from "../../src/utils/logging.js";
import { httpError, nodeError } from "../helpers/fake-docs.js";

const auth: AuthProvider = { getClient: async () => ({}) as never };
const msg = { to: ["a@example.com"], subject: "Hi", body: "Body", bodyType: "text" as const };

function svc(send: GmailPort["send"], a: AuthProvider = auth) {
  return new GmailService({ gmailFor: () => ({ send }), auth: a, logger: nullLogger });
}

describe("GmailService.sendEmail", () => {
  it("sends once and returns the Gmail IDs", async () => {
    const send = vi.fn(async (_raw: string) => ({ id: "m1", threadId: "t1" }));
    await expect(svc(send).sendEmail(msg)).resolves.toEqual({ messageId: "m1", threadId: "t1" });
    expect(send).toHaveBeenCalledTimes(1);
    const raw = send.mock.calls[0]![0] as string;
    expect(raw).not.toMatch(/[+/=]/);
    expect(Buffer.from(raw, "base64url").toString()).toContain("To: a@example.com");
  });

  it.each([
    [httpError(400, "x", "invalidArgument"), "INVALID_ARGUMENT"],
    [httpError(401), "AUTH_EXPIRED"],
    [httpError(403, "x", "insufficientPermissions"), "AUTH_REQUIRED"],
    [httpError(403, "x", "forbidden"), "PERMISSION_DENIED"],
    [httpError(429), "RATE_LIMITED"],
  ])("maps definite rejection %# to %s and never retries", async (err, code) => {
    const send = vi.fn().mockRejectedValue(err);
    await expect(svc(send).sendEmail(msg)).rejects.toMatchObject({ code });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    nodeError("ETIMEDOUT"),
    nodeError("ECONNRESET"),
    httpError(503),
    new Error("timeout of 20000ms exceeded"),
  ])(
    "treats ambiguous failure %# as OPERATION_OUTCOME_UNKNOWN with exactly one send",
    async (err) => {
      const send = vi.fn().mockRejectedValue(err);
      const e = await svc(send)
        .sendEmail(msg)
        .catch((x) => x);
      expect(e.code).toBe("OPERATION_OUTCOME_UNKNOWN");
      expect(e.retryable).toBe(false);
      expect(e.message).toMatch(/Sent folder/);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a delivery-less network failure as retryable NETWORK_ERROR", async () => {
    const send = vi.fn().mockRejectedValue(nodeError("ENOTFOUND"));
    await expect(svc(send).sendEmail(msg)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
    });
  });

  it("does not claim success without a message ID", async () => {
    const send = vi.fn(async () => ({}));
    await expect(svc(send).sendEmail(msg)).rejects.toMatchObject({
      code: "OPERATION_OUTCOME_UNKNOWN",
    });
  });

  it("fails on auth problems without sending", async () => {
    const send = vi.fn();
    const bad: AuthProvider = {
      getClient: async () => {
        throw new AppError("AUTH_EXPIRED");
      },
    };
    await expect(svc(send, bad).sendEmail(msg)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("has no retry logic in its source", () => {
    const source = fs.readFileSync(
      new URL("../../src/google/gmail-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/withRetry|retry\.js/);
  });
});

describe("gmail_send_email tool handler", () => {
  const config = { gmailMaxRecipients: 4, gmailMaxSubjectChars: 20, gmailMaxBodyBytes: 50 };
  const sendEmail = vi.fn(async () => ({ messageId: "m9", threadId: "t9" }));
  const tool = createGmailSendTool({ gmail: { sendEmail }, config });
  const run = (args: Record<string, unknown>) =>
    tool.handler({ to: "a@b.com", subject: "S", body: "B", ...args } as never, {
      requestId: "r",
      audit: {},
    });

  it("sends with defaults and returns IDs only", async () => {
    sendEmail.mockClear();
    const r = await run({});
    expect(r).toEqual({ success: true, message: "Email sent.", message_id: "m9", thread_id: "t9" });
    expect(sendEmail).toHaveBeenCalledWith({
      to: ["a@b.com"],
      subject: "S",
      body: "B",
      bodyType: "text",
    });
  });
  it("accepts arrays, cc, bcc, reply_to and html", async () => {
    sendEmail.mockClear();
    await run({
      to: ["a@b.com", "c@d.com"],
      cc: "e@f.com",
      bcc: ["g@h.com"],
      reply_to: "r@x.com",
      body_type: "html",
    });
    expect(sendEmail).toHaveBeenCalledWith({
      to: ["a@b.com", "c@d.com"],
      cc: ["e@f.com"],
      bcc: ["g@h.com"],
      replyTo: "r@x.com",
      subject: "S",
      body: "B",
      bodyType: "html",
    });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["empty to", { to: [] }, /at least one/],
    ["blank to entry", { to: [" "] }, /empty/],
    ["bad address", { to: "nope" }, /invalid email/],
    ["bad cc", { cc: "x@" }, /'cc'/],
    ["bad reply_to", { reply_to: "no" }, /reply_to/],
    ["blank subject", { subject: "   " }, /subject/],
    ["multi-line subject", { subject: "a\nBcc: x@y.com" }, /single line/],
    ["long subject", { subject: "x".repeat(21) }, /too long/],
    ["blank body", { body: " \n " }, /body/],
    ["big body", { body: "x".repeat(51) }, /too large/],
    [
      "too many recipients",
      { to: ["a@b.com", "b@b.com"], cc: ["c@b.com", "e@b.com"], bcc: ["d@b.com"] },
      /Too many/,
    ],
    ["duplicates across fields", { to: "a@b.com", bcc: "A@B.com" }, /more than once/],
  ])("rejects %s", async (_n, args, re) => {
    sendEmail.mockClear();
    await expect(run(args)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringMatching(re),
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
