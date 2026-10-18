import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { createDocsAppendTool } from "../../src/tools/docs-append.js";
import { createGmailSendTool } from "../../src/tools/gmail-send.js";
import { AppError } from "../../src/utils/errors.js";
import { createLogger } from "../../src/utils/logging.js";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abc";
const cfg = {
  gmailMaxRecipients: 50,
  gmailMaxSubjectChars: 500,
  gmailMaxBodyBytes: 1_000_000,
  docsMaxAppendChars: 50_000,
};

async function setup(
  overrides: { send?: () => Promise<{ messageId: string }>; append?: () => Promise<unknown> } = {},
) {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", stream: { write: (s) => lines.push(s) } });
  const send = overrides.send ?? (async () => ({ messageId: "msg-1" }));
  const append =
    overrides.append ?? (async () => ({ documentId: ID, appendedCharacters: 3, verified: false }));
  const server = createServer({
    tools: [
      createGmailSendTool({ gmail: { sendEmail: send as never }, config: cfg }),
      createDocsAppendTool({ docs: { appendText: append as never }, config: cfg }),
    ],
    logger,
    version: "1.2.3",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, lines };
}

describe("tool discovery", () => {
  it("exposes exactly the two tools with accurate schemas", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "gmail_send_email",
      "google_docs_append_text",
    ]);

    const gmail = tools.find((t) => t.name === "gmail_send_email")!;
    expect(gmail.description).toMatch(/real email/i);
    expect(gmail.description).toMatch(/cannot be undone/i);
    expect(gmail.inputSchema.required?.sort()).toEqual(["body", "subject", "to"]);
    expect(Object.keys(gmail.inputSchema.properties!).sort()).toEqual([
      "bcc",
      "body",
      "body_type",
      "cc",
      "reply_to",
      "subject",
      "to",
    ]);
    expect((gmail.inputSchema.properties!.body_type as { enum: string[] }).enum).toEqual([
      "text",
      "html",
    ]);
    expect(gmail.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });

    const docs = tools.find((t) => t.name === "google_docs_append_text")!;
    expect(docs.description).toMatch(/modifies the document/i);
    expect(docs.description).toMatch(/never changed or removed/i);
    expect(docs.inputSchema.required).toEqual(["text"]);
    expect(Object.keys(docs.inputSchema.properties!).sort()).toEqual([
      "add_separator_newline",
      "document_id",
      "document_url",
      "heading",
      "insert_timestamp",
      "text",
    ]);
    for (const t of tools) {
      expect(t.outputSchema).toBeDefined();
      for (const p of Object.values(t.inputSchema.properties!))
        expect((p as { description?: string }).description).toBeTruthy();
    }
  });
});

describe("tool calls", () => {
  it("returns structured success plus readable text", async () => {
    const { client } = await setup();
    const r = await client.callTool({
      name: "gmail_send_email",
      arguments: { to: "a@b.com", subject: "S", body: "B" },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      success: true,
      message: "Email sent.",
      message_id: "msg-1",
    });
    expect((r.structuredContent as { request_id: string }).request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((r.content as Array<{ text: string }>)[0]!.text).toContain("Email sent.");
  });

  it("returns the FR-5 error envelope for validation failures", async () => {
    const { client } = await setup();
    const r = await client.callTool({
      name: "gmail_send_email",
      arguments: { to: "bad", subject: "S", body: "B" },
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      success: false,
      error: { code: "INVALID_ARGUMENT", retryable: false },
    });
  });

  it("reports malformed arguments (schema violation) without crashing", async () => {
    const { client } = await setup();
    const r = await client
      .callTool({ name: "gmail_send_email", arguments: { subject: "S" } })
      .catch((e) => e);
    // Depending on SDK version this is a protocol error or an isError result: either is acceptable.
    const failed = r instanceof Error || (r as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
    const ok = await client.callTool({
      name: "gmail_send_email",
      arguments: { to: "a@b.com", subject: "S", body: "B" },
    });
    expect(ok.isError).toBeFalsy();
  });

  it("converts unexpected exceptions to INTERNAL_ERROR and keeps serving", async () => {
    let n = 0;
    const { client } = await setup({
      send: async () => {
        if (n++ === 0) throw new TypeError("internal detail ya29.SECRET");
        return { messageId: "ok" };
      },
    });
    const args = { to: "a@b.com", subject: "S", body: "B" };
    const bad = await client.callTool({ name: "gmail_send_email", arguments: args });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({
      success: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(JSON.stringify(bad)).not.toContain("ya29");
    const good = await client.callTool({ name: "gmail_send_email", arguments: args });
    expect(good.structuredContent).toMatchObject({ success: true });
  });

  it("passes AppError codes through and never marks unknown outcomes retryable", async () => {
    const { client } = await setup({
      append: async () => {
        throw new AppError("OPERATION_OUTCOME_UNKNOWN", "check the doc", { retryable: true });
      },
    });
    const r = await client.callTool({
      name: "google_docs_append_text",
      arguments: { document_id: ID, text: "x" },
    });
    expect(r.structuredContent).toMatchObject({
      success: false,
      error: { code: "OPERATION_OUTCOME_UNKNOWN", retryable: false },
    });
  });
});

describe("logging canary", () => {
  it("never writes content, recipients, document IDs or tokens to logs", async () => {
    const { client, lines } = await setup({
      send: async () => {
        throw Object.assign(
          new Error("Bearer ya29.CANARYTOKEN failed for canary-rcpt@example.com"),
          {
            config: { headers: { Authorization: "Bearer ya29.CANARYTOKEN" } },
          },
        );
      },
    });
    await client.callTool({
      name: "gmail_send_email",
      arguments: {
        to: "canary-rcpt@example.com",
        cc: "canary-cc@example.com",
        subject: "CANARY-SUBJECT",
        body: "CANARY-BODY",
      },
    });
    await client.callTool({
      name: "gmail_send_email",
      arguments: { to: "canary-rcpt@example.com", subject: "CANARY-SUBJECT", body: "CANARY-BODY" },
    });
    await client.callTool({
      name: "google_docs_append_text",
      arguments: { document_id: ID, text: "CANARY-TEXT", heading: "CANARY-HEADING" },
    });
    const all = lines.join("");
    expect(lines.length).toBeGreaterThan(0);
    for (const canary of ["CANARY", "canary-", "ya29", ID]) expect(all).not.toContain(canary);
    expect(all).toContain('"tool":"google_docs_append_text"');
    expect(all).toContain("doc_hash");
  });
});
