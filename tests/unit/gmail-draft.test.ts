import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../../src/auth/google-oauth.js";
import type { GmailPort } from "../../src/google/clients.js";
import { GmailService } from "../../src/google/gmail-service.js";
import { createGmailDraftTool } from "../../src/tools/gmail-draft.js";
import { AppError } from "../../src/utils/errors.js";
import { nullLogger } from "../../src/utils/logging.js";
import { httpError, nodeError } from "../helpers/fake-docs.js";

const auth: AuthProvider = { getClient: async () => ({}) as never };
const msg = { to: ["a@example.com"], subject: "Hi", body: "Body", bodyType: "text" as const };

function svc(createDraft: GmailPort["createDraft"], a: AuthProvider = auth) {
  const send = vi.fn();
  const service = new GmailService({
    gmailFor: () => ({ send, createDraft }),
    auth: a,
    logger: nullLogger,
  });
  return { service, send };
}

describe("GmailService.createDraft", () => {
  it("creates one draft, returns the IDs and never sends", async () => {
    const createDraft = vi.fn(async (_raw: string) => ({ id: "d1", messageId: "m1" }));
    const { service, send } = svc(createDraft);
    await expect(service.createDraft(msg)).resolves.toEqual({ draftId: "d1", messageId: "m1" });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    const raw = createDraft.mock.calls[0]![0];
    expect(raw).not.toMatch(/[+/=]/);
    expect(Buffer.from(raw, "base64url").toString()).toContain("To: a@example.com");
  });

  it("asks the auth provider for the compose capability, not the send one", async () => {
    const getClient = vi.fn(async () => ({}) as never);
    const { service } = svc(
      vi.fn(async () => ({ id: "d1" })),
      { getClient },
    );
    await service.createDraft(msg);
    expect(getClient).toHaveBeenCalledWith("gmail_draft");
  });

  it.each([
    [httpError(400, "x", "invalidArgument"), "INVALID_ARGUMENT"],
    [httpError(401), "AUTH_EXPIRED"],
    [httpError(403, "x", "insufficientPermissions"), "AUTH_REQUIRED"],
    [httpError(429), "RATE_LIMITED"],
  ])("maps definite rejection %# to %s and never retries", async (err, code) => {
    const createDraft = vi.fn().mockRejectedValue(err);
    const { service } = svc(createDraft);
    await expect(service.createDraft(msg)).rejects.toMatchObject({ code });
    expect(createDraft).toHaveBeenCalledTimes(1);
  });

  it.each([
    nodeError("ETIMEDOUT"),
    nodeError("ECONNRESET"),
    httpError(503),
    new Error("timeout of 20000ms exceeded"),
  ])("treats ambiguous failure %# as OPERATION_OUTCOME_UNKNOWN with one call", async (err) => {
    const createDraft = vi.fn().mockRejectedValue(err);
    const { service } = svc(createDraft);
    const e = await service.createDraft(msg).catch((x) => x);
    expect(e.code).toBe("OPERATION_OUTCOME_UNKNOWN");
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/Check Drafts before trying again/);
    expect(createDraft).toHaveBeenCalledTimes(1);
  });

  it("reports a delivery-less network failure as retryable NETWORK_ERROR", async () => {
    const { service } = svc(vi.fn().mockRejectedValue(nodeError("ENOTFOUND")));
    await expect(service.createDraft(msg)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
    });
  });

  it("does not claim success without a draft ID", async () => {
    const { service } = svc(vi.fn(async () => ({})));
    await expect(service.createDraft(msg)).rejects.toMatchObject({
      code: "OPERATION_OUTCOME_UNKNOWN",
    });
  });

  it("fails on expired auth without calling Gmail", async () => {
    const createDraft = vi.fn();
    const bad: AuthProvider = {
      getClient: async () => {
        throw new AppError("AUTH_EXPIRED");
      },
    };
    const { service } = svc(createDraft, bad);
    await expect(service.createDraft(msg)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("never references the send API from the draft code paths", () => {
    const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
    expect(read("../../src/tools/gmail-draft.ts")).not.toMatch(/sendEmail|\.send\(/);
    const service = read("../../src/google/gmail-service.ts");
    const draftMethod = service.slice(service.indexOf("async createDraft"));
    expect(draftMethod).not.toMatch(/api\.send|sendEmail/);
  });
});

describe("gmail_create_draft tool handler", () => {
  const config = { gmailMaxRecipients: 4, gmailMaxSubjectChars: 20, gmailMaxBodyBytes: 50 };
  const createDraft = vi.fn(async () => ({ draftId: "d9", messageId: "m9" }));
  const sendEmail = vi.fn();
  // Only createDraft is handed over, so the tool has no way to reach sendEmail.
  const tool = createGmailDraftTool({ gmail: { createDraft }, config });
  const run = (args: Record<string, unknown>) =>
    tool.handler({ to: "a@b.com", subject: "S", body: "B", ...args } as never, {
      requestId: "r",
      audit: {},
    });

  it("describes itself as never sending", () => {
    expect(tool.name).toBe("gmail_create_draft");
    expect(tool.description).toMatch(/never sends/i);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });

  it("creates a draft with defaults and returns IDs only", async () => {
    createDraft.mockClear();
    const r = await run({});
    expect(r).toEqual({
      success: true,
      message: "Draft created.",
      draft_id: "d9",
      message_id: "m9",
    });
    expect(createDraft).toHaveBeenCalledWith({
      to: ["a@b.com"],
      subject: "S",
      body: "B",
      bodyType: "text",
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("accepts arrays, cc, bcc, reply_to and html", async () => {
    createDraft.mockClear();
    await run({
      to: ["a@b.com", "c@d.com"],
      cc: "e@f.com",
      bcc: ["g@h.com"],
      reply_to: "r@x.com",
      body_type: "html",
    });
    expect(createDraft).toHaveBeenCalledWith({
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
    ["bad address", { to: "nope" }, /invalid email/],
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
    createDraft.mockClear();
    await expect(run(args)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringMatching(re),
    });
    expect(createDraft).not.toHaveBeenCalled();
  });
});
