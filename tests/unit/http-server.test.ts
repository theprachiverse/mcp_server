import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp, type HttpAppDeps } from "../../src/http/app.js";
import { createDocsAppendTool } from "../../src/tools/docs-append.js";
import { createGmailSendTool } from "../../src/tools/gmail-send.js";
import { createLogger } from "../../src/utils/logging.js";

const TOKEN = "t".repeat(16) + "SECRET-TOKEN-VALUE-0123456789";
const cfg = {
  gmailMaxRecipients: 50,
  gmailMaxSubjectChars: 500,
  gmailMaxBodyBytes: 1_000_000,
  docsMaxAppendChars: 50_000,
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function start(overrides: Partial<HttpAppDeps> = {}) {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", stream: { write: (s) => lines.push(s) } });
  const sent: unknown[] = [];
  const app = createHttpApp({
    tools: [
      createGmailSendTool({
        gmail: {
          sendEmail: (async (m: unknown) => {
            sent.push(m);
            return { messageId: "msg-1" };
          }) as never,
        },
        config: cfg,
      }),
      createDocsAppendTool({ docs: { appendText: (async () => ({})) as never }, config: cfg }),
    ],
    logger,
    version: "9.9.9",
    authToken: TOKEN,
    allowedHosts: ["localhost", "127.0.0.1", "[::1]", "mcp.example.com"],
    rateLimitPerMinute: 1000,
    trustProxy: 0,
    ...overrides,
  });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, lines, sent };
}

const rpc = (method: string, params: object = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const mcpHeaders = (token?: string): Record<string, string> => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

describe("health check", () => {
  it("answers 200 without credentials and reveals nothing", async () => {
    const { url } = await start();
    const r = await fetch(`${url}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok" });
  });

  it("answers even when the Host header is not on the allow-list (Railway's health checker)", async () => {
    const { url } = await start();
    // fetch() forbids overriding Host, so use the low-level client.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${url}/healthz`,
        { headers: { Host: "healthcheck.railway.app" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
  });
});

describe("bearer authentication on /mcp", () => {
  it("rejects a missing, wrong or malformed token with 401 and never runs a tool", async () => {
    const { url, lines } = await start();
    for (const headers of [
      mcpHeaders(),
      mcpHeaders("wrong-token"),
      { ...mcpHeaders(), Authorization: TOKEN }, // no "Bearer " scheme
    ]) {
      const r = await fetch(`${url}/mcp`, { method: "POST", headers, body: rpc("tools/list") });
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe("Bearer");
    }
    const log = lines.join("");
    expect(log).toContain("auth.rejected");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("wrong-token");
  });

  it("accepts the correct token and never logs it", async () => {
    const { url, lines } = await start();
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: mcpHeaders(TOKEN),
      body: rpc("tools/list"),
    });
    expect(r.status).toBe(200);
    expect(lines.join("")).not.toContain(TOKEN);
  });
});

describe("MCP over Streamable HTTP", () => {
  it("lets a real MCP client list exactly the two tools and call one", async () => {
    const { url, sent } = await start();
    const client = new Client({ name: "http-test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }) as Transport,
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "gmail_send_email",
        "google_docs_append_text",
      ]);

      const result = await client.callTool({
        name: "gmail_send_email",
        arguments: { to: "someone@example.com", subject: "Hi", body: "Hello" },
      });
      expect(result.isError).toBe(false);
      expect((result.structuredContent as { message_id: string }).message_id).toBe("msg-1");
      expect(sent).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("rejects GET and DELETE on /mcp with 405 (stateless mode)", async () => {
    const { url } = await start();
    for (const method of ["GET", "DELETE"]) {
      const r = await fetch(`${url}/mcp`, { method, headers: mcpHeaders(TOKEN) });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
  });

  it("returns a JSON error, not a stack trace, for malformed JSON", async () => {
    const { url } = await start();
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: mcpHeaders(TOKEN),
      body: '{"jsonrpc": ',
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Invalid request body.");
  });

  it("rejects bodies over the size limit with 413", async () => {
    const { url } = await start();
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: mcpHeaders(TOKEN),
      body: JSON.stringify({ pad: "x".repeat(3 * 1024 * 1024) }),
    });
    expect(r.status).toBe(413);
  });
});

describe("host header protection", () => {
  it("rejects a Host that is not allowed, even with a valid token", async () => {
    const { url } = await start({ allowedHosts: ["mcp.example.com"] });
    // 127.0.0.1 is not on this list.
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: mcpHeaders(TOKEN),
      body: rpc("tools/list"),
    });
    expect(r.status).toBe(403);
  });
});

describe("rate limiting", () => {
  it("returns 429 once the per-minute limit is exceeded, including for bad tokens", async () => {
    const { url } = await start({ rateLimitPerMinute: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: mcpHeaders("wrong-token"),
        body: rpc("tools/list"),
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });
});

describe("unknown routes", () => {
  it("answers 404 with JSON", async () => {
    const { url } = await start();
    const r = await fetch(`${url}/nope`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });
});
