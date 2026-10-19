import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../../src/auth/google-oauth.js";
import type { DocsPort } from "../../src/google/clients.js";
import { DocsService } from "../../src/google/docs-service.js";
import { createDocsCreateTool } from "../../src/tools/docs-create.js";
import { AppError } from "../../src/utils/errors.js";
import { nullLogger } from "../../src/utils/logging.js";
import { FakeDocs, httpError, nodeError } from "../helpers/fake-docs.js";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abc";
const auth: AuthProvider = { getClient: async () => ({}) as never };

function service(port: Partial<DocsPort> & Pick<DocsPort, "create">, a: AuthProvider = auth) {
  const fake = new FakeDocs("\n");
  const merged: DocsPort = {
    get: () => fake.get(),
    batchUpdate: (...args) => fake.batchUpdate(...args),
    ...port,
  };
  return {
    fake,
    svc: new DocsService({
      docsFor: () => merged,
      auth: a,
      config: { docsMaxWriteAttempts: 3, docsTimestampTimezone: "UTC" },
      logger: nullLogger,
      retry: { sleep: async () => {} },
    }),
  };
}

describe("DocsService.createDocument", () => {
  it("creates once and returns the ID without touching the body", async () => {
    const create = vi.fn(async () => ({ documentId: ID }));
    const { svc, fake } = service({ create });
    await expect(svc.createDocument("Weekly pulse")).resolves.toEqual({
      documentId: ID,
      appendedCharacters: 0,
    });
    expect(create).toHaveBeenCalledExactlyOnceWith("Weekly pulse");
    expect(fake.batchCalls).toHaveLength(0);
  });

  it("appends the initial text to the empty document", async () => {
    const { svc, fake } = service({ create: async () => ({ documentId: ID }) });
    const r = await svc.createDocument("T", "Hello\nWorld");
    expect(r).toEqual({ documentId: ID, appendedCharacters: 11 });
    expect(fake.text).toBe("Hello\nWorld\n");
  });

  it("asks for the docs capability (no new scope)", async () => {
    const getClient = vi.fn(async () => ({}) as never);
    const { svc } = service({ create: async () => ({ documentId: ID }) }, { getClient });
    await svc.createDocument("T");
    expect(getClient).toHaveBeenCalledWith("docs");
  });

  it.each([
    [httpError(400, "x", "invalidArgument"), "INVALID_ARGUMENT"],
    [httpError(401), "AUTH_EXPIRED"],
    [httpError(403, "x", "insufficientPermissions"), "AUTH_REQUIRED"],
    [httpError(429), "RATE_LIMITED"],
  ])("maps definite rejection %# to %s and never retries", async (err, code) => {
    const create = vi.fn().mockRejectedValue(err);
    const { svc } = service({ create });
    await expect(svc.createDocument("T")).rejects.toMatchObject({ code });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    nodeError("ETIMEDOUT"),
    nodeError("ECONNRESET"),
    httpError(503),
    new Error("timeout of 20000ms exceeded"),
  ])("treats ambiguous failure %# as OPERATION_OUTCOME_UNKNOWN with one create", async (err) => {
    const create = vi.fn().mockRejectedValue(err);
    const { svc } = service({ create });
    const e = await svc.createDocument("T", "x").catch((x) => x);
    expect(e.code).toBe("OPERATION_OUTCOME_UNKNOWN");
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/Check Google Drive for a doc with this title before retrying/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reports a delivery-less network failure as retryable NETWORK_ERROR", async () => {
    const { svc } = service({ create: vi.fn().mockRejectedValue(nodeError("ENOTFOUND")) });
    await expect(svc.createDocument("T")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
    });
  });

  it("does not claim success without a document ID", async () => {
    const { svc } = service({ create: async () => ({}) });
    await expect(svc.createDocument("T")).rejects.toMatchObject({
      code: "OPERATION_OUTCOME_UNKNOWN",
    });
  });

  it("fails on expired auth without creating anything", async () => {
    const create = vi.fn();
    const bad: AuthProvider = {
      getClient: async () => {
        throw new AppError("AUTH_EXPIRED");
      },
    };
    const { svc } = service({ create }, bad);
    await expect(svc.createDocument("T")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(create).not.toHaveBeenCalled();
  });

  it("names the new document when only the initial text failed, and does not create again", async () => {
    const create = vi.fn(async () => ({ documentId: ID }));
    const { svc, fake } = service({ create });
    fake.getErrors.push(httpError(401));
    const e = await svc.createDocument("T", "text").catch((x) => x);
    expect(e).toMatchObject({ code: "AUTH_EXPIRED", retryable: false });
    expect(e.message).toContain(ID);
    expect(e.message).toMatch(/google_docs_append_text/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("has no retry around the create call", () => {
    const source = fs.readFileSync(
      new URL("../../src/google/docs-service.ts", import.meta.url),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("async createDocument"),
      source.indexOf("async appendText"),
    );
    expect(body).not.toMatch(/withRetry/);
  });
});

describe("google_docs_create tool handler", () => {
  const createDocument = vi.fn(async (_title: string, _text?: string) => ({
    documentId: ID,
    appendedCharacters: 0,
  }));
  const tool = createDocsCreateTool({
    docs: { createDocument },
    config: { docsMaxAppendChars: 100 },
  });
  const run = (args: Record<string, unknown>) =>
    tool.handler({ title: "Weekly pulse", ...args } as never, { requestId: "r", audit: {} });

  it("creates a document and rebuilds the URL", async () => {
    createDocument.mockClear();
    const r = await run({});
    expect(r).toEqual({
      success: true,
      message: "Document created.",
      document_id: ID,
      document_url: `https://docs.google.com/document/d/${ID}/edit`,
    });
    expect(createDocument).toHaveBeenCalledWith("Weekly pulse", undefined);
  });

  it("trims the title and passes the initial text through", async () => {
    createDocument.mockClear();
    await run({ title: "  Weekly pulse  ", initial_text: "hello" });
    expect(createDocument).toHaveBeenCalledWith("Weekly pulse", "hello");
  });

  it("treats a blank initial_text as absent", async () => {
    createDocument.mockClear();
    await run({ initial_text: " \n " });
    expect(createDocument).toHaveBeenCalledWith("Weekly pulse", undefined);
  });

  it("accepts the limits exactly", async () => {
    createDocument.mockClear();
    await run({ title: "t".repeat(200), initial_text: "x".repeat(100) });
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["blank title", { title: "   " }, /title/],
    ["multi-line title", { title: "a\nb" }, /single line/],
    ["control chars in title", { title: "a\u0000b" }, /control/],
    ["long title", { title: "t".repeat(201) }, /too long/],
    ["long initial_text", { initial_text: "x".repeat(101) }, /too long/],
    ["control chars in initial_text", { initial_text: "a\u0000b" }, /control/],
  ])("rejects %s", async (_n, args, re) => {
    createDocument.mockClear();
    await expect(run(args)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringMatching(re),
    });
    expect(createDocument).not.toHaveBeenCalled();
  });
});
