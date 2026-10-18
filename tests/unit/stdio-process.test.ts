import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gwmcp-proc-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// tsx is referenced by absolute URL because the tests run the server from another folder.
const tsxUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const nodeArgs = ["--import", tsxUrl, path.join(root, "src/index.ts")];
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("GOOGLE_") && k !== "LOG_LEVEL"),
) as Record<string, string>;

describe("stdio server process", () => {
  it("starts from any working directory without a token, lists tools and answers AUTH_REQUIRED", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: nodeArgs,
      cwd: tmp, // deliberately not the project folder
      env: {
        ...baseEnv,
        GOOGLE_OAUTH_CLIENT_ID: "test-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "test-secret",
        GOOGLE_TOKEN_PATH: path.join(tmp, "missing", "token.json"),
        LOG_LEVEL: "info",
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: "proc-test", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "gmail_send_email",
        "google_docs_append_text",
      ]);

      const r = await client.callTool({
        name: "gmail_send_email",
        arguments: { to: "someone@example.com", subject: "PROC-SUBJECT", body: "PROC-BODY" },
      });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({
        success: false,
        error: { code: "AUTH_REQUIRED" },
      });

      // The server is still alive after the failure.
      expect((await client.listTools()).tools).toHaveLength(2);
    } finally {
      await client.close();
    }
    expect(stderr).toContain("server.started");
    for (const leak of ["PROC-SUBJECT", "PROC-BODY", "someone@example.com", "test-secret"]) {
      expect(stderr).not.toContain(leak);
    }
  }, 30_000);

  it("refuses to start with a clear stderr message and empty stdout when config is missing", () => {
    const r = spawnSync(process.execPath, nodeArgs, {
      cwd: tmp,
      env: { ...baseEnv, GOOGLE_OAUTH_CLIENT_SECRET: "never-print-me" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect(r.stderr).not.toContain("never-print-me");
  }, 30_000);
});
