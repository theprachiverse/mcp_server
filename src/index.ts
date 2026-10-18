import fs from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GoogleAuthProvider } from "./auth/google-oauth.js";
import { TokenStore } from "./auth/token-store.js";
import { ConfigError, findProjectRoot, loadConfig, loadDotEnv } from "./config.js";
import { createDocsFactory, createGmailFactory } from "./google/clients.js";
import { DocsService } from "./google/docs-service.js";
import { GmailService } from "./google/gmail-service.js";
import { createServer } from "./server.js";
import { createDocsAppendTool } from "./tools/docs-append.js";
import { createGmailSendTool } from "./tools/gmail-send.js";
import { createLogger } from "./utils/logging.js";

async function main(): Promise<void> {
  const root = findProjectRoot();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    version: string;
  };

  let config;
  try {
    loadDotEnv(root);
    config = loadConfig(process.env, root);
  } catch (err) {
    // stdout is reserved for MCP messages, so report on stderr.
    process.stderr.write(
      `google-workspace-mcp: ${err instanceof ConfigError ? err.message : "failed to load configuration"}\n`,
    );
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel });
  const store = new TokenStore(config.tokenPath);
  const auth = new GoogleAuthProvider(config, store, logger);
  const ua = pkg.version;

  const gmail = new GmailService({
    gmailFor: createGmailFactory(config.apiTimeoutMs, ua),
    auth,
    logger,
  });
  const docs = new DocsService({
    docsFor: createDocsFactory(config.apiTimeoutMs, ua),
    auth,
    config,
    logger,
  });

  const server = createServer({
    tools: [createGmailSendTool({ gmail, config }), createDocsAppendTool({ docs, config })],
    logger,
    version: pkg.version,
  });

  await server.connect(new StdioServerTransport());
  logger.info("server.started", {
    version: pkg.version,
    node: process.version,
    token_file_present: store.mtimeMs() !== null,
  });

  const shutdown = (signal: string) => {
    logger.info("server.stopping", { signal });
    server
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.on("close", () => shutdown("stdin_closed"));

  process.on("unhandledRejection", (reason) =>
    logger.error("process.unhandled_rejection", { error: reason }),
  );
  process.on("uncaughtException", (error) => {
    logger.error("process.uncaught_exception", { error });
    process.exit(1);
  });
}

main().catch((err) => {
  process.stderr.write(
    `google-workspace-mcp: failed to start (${err instanceof Error ? err.name : "error"})\n`,
  );
  process.exit(1);
});
