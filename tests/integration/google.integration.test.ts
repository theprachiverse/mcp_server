/**
 * Opt-in tests against a REAL Google test account. They are skipped unless the variables in
 * tests/integration/env.ts are set. Never point them at production documents or recipients.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GoogleAuthProvider, SCOPE_DOCS, SCOPE_GMAIL_SEND } from "../../src/auth/google-oauth.js";
import { TokenStore } from "../../src/auth/token-store.js";
import { findProjectRoot, loadConfig } from "../../src/config.js";
import { createDocsFactory } from "../../src/google/clients.js";
import { bodyPlainText } from "../../src/google/docs-index.js";
import { nullLogger } from "../../src/utils/logging.js";
import { READONLY_DOC_ID, TEST_DOC_ID, TEST_RECIPIENT, docsEnabled, emailEnabled } from "./env.js";

const root = findProjectRoot();
const tsxUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts");

let client: Client;
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  return r as { isError?: boolean; structuredContent: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

async function readDocText(): Promise<string> {
  const config = loadConfig(process.env, root);
  const auth = new GoogleAuthProvider(config, new TokenStore(config.tokenPath), nullLogger);
  const port = createDocsFactory(
    config.apiTimeoutMs,
    "integration-test",
  )(await auth.getClient("docs"));
  return bodyPlainText((await port.get(TEST_DOC_ID)).body);
}

describe.skipIf(!docsEnabled && !emailEnabled)("real Google integration", () => {
  beforeAll(async () => {
    client = new Client({ name: "integration", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", tsxUrl, entry],
        env: Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => v !== undefined),
        ) as Record<string, string>,
      }),
    );
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  it.skipIf(!docsEnabled)("is authorised without any broader Google access", async () => {
    const config = loadConfig(process.env, root);
    const granted = (new TokenStore(config.tokenPath).read()?.scope ?? "").split(" ");
    expect(granted).toContain(SCOPE_GMAIL_SEND);
    expect(granted).toContain(SCOPE_DOCS);
    // Google reports 'email' as .../auth/userinfo.email; anything else would be extra access.
    const allowed = new Set([
      SCOPE_GMAIL_SEND,
      SCOPE_DOCS,
      "openid",
      "email",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
    expect(granted.filter((s) => !allowed.has(s))).toEqual([]);
  });

  describe.skipIf(!docsEnabled)("google_docs_append_text", () => {
    it("appends a marker at the end and preserves earlier content", async () => {
      const before = await readDocText();
      const marker = `IT-${randomUUID()}`;
      const r = await call("google_docs_append_text", { document_id: TEST_DOC_ID, text: marker });
      expect(r.structuredContent).toMatchObject({ success: true, document_id: TEST_DOC_ID });
      const after = await readDocText();
      expect(after.startsWith(before.slice(0, -1))).toBe(true); // all earlier text is an exact prefix
      expect(after.endsWith(`${marker}\n`)).toBe(true);
    });

    it("leaves one blank line between consecutive appends", async () => {
      const a = `IT-A-${randomUUID()}`;
      const b = `IT-B-${randomUUID()}`;
      await call("google_docs_append_text", { document_id: TEST_DOC_ID, text: a });
      await call("google_docs_append_text", { document_id: TEST_DOC_ID, text: b });
      expect((await readDocText()).endsWith(`${a}\n\n${b}\n`)).toBe(true);
    });

    it("accepts a document URL and an optional heading", async () => {
      const marker = `IT-H-${randomUUID()}`;
      const r = await call("google_docs_append_text", {
        document_url: `https://docs.google.com/document/d/${TEST_DOC_ID}/edit`,
        text: marker,
        heading: "Integration heading",
      });
      expect(r.structuredContent.success).toBe(true);
      expect((await readDocText()).endsWith(`Integration heading\n${marker}\n`)).toBe(true);
    });

    it("returns RESOURCE_NOT_FOUND for a well-formed ID that does not exist", async () => {
      const r = await call("google_docs_append_text", {
        document_id: "1" + "x".repeat(43),
        text: "should never be written",
      });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error.code).toBe("RESOURCE_NOT_FOUND");
    });

    it.skipIf(!READONLY_DOC_ID)("returns PERMISSION_DENIED for a view-only document", async () => {
      const r = await call("google_docs_append_text", {
        document_id: READONLY_DOC_ID,
        text: "nope",
      });
      expect(r.structuredContent.error.code).toBe("PERMISSION_DENIED");
    });

    it("rejects non-Google URLs before any API call", async () => {
      const r = await call("google_docs_append_text", {
        document_url: `https://evil.example/document/d/${TEST_DOC_ID}/edit`,
        text: "x",
      });
      expect(r.structuredContent.error.code).toBe("INVALID_ARGUMENT");
    });
  });

  describe.skipIf(!emailEnabled)("gmail_send_email", () => {
    it("sends to the allow-listed test mailbox and returns a message ID", async () => {
      const marker = `IT-${randomUUID()}`;
      const r = await call("gmail_send_email", {
        to: TEST_RECIPIENT,
        subject: `Integration test ${marker}`,
        body: `Automated test message ${marker}. Safe to delete.`,
      });
      expect(r.structuredContent.success).toBe(true);
      expect(r.structuredContent.message_id).toBeTruthy();
      // gmail.send cannot read mail: confirm arrival manually (subject contains the marker).
      console.warn(
        `[integration] check ${TEST_RECIPIENT} and the Sent folder for marker ${marker}`,
      );
    });
  });
});
