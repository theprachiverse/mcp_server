import fs from "node:fs";
import path from "node:path";
import { GoogleAuthProvider } from "./auth/google-oauth.js";
import { TokenStore } from "./auth/token-store.js";
import type { Config } from "./config.js";
import { createDocsFactory, createGmailFactory } from "./google/clients.js";
import { DocsService } from "./google/docs-service.js";
import { GmailService } from "./google/gmail-service.js";
import { createDocsAppendTool } from "./tools/docs-append.js";
import { createGmailSendTool } from "./tools/gmail-send.js";
import type { ToolDefinition } from "./tools/types.js";
import { createLogger, type Logger } from "./utils/logging.js";

export function readVersion(root: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

export interface Runtime {
  logger: Logger;
  store: TokenStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: ToolDefinition<any>[];
}

/** Wires the services and tools. Shared by the stdio and HTTP entry points. */
export function createRuntime(config: Config, version: string): Runtime {
  const logger = createLogger({ level: config.logLevel });
  const store = new TokenStore(config.tokenPath);
  const auth = new GoogleAuthProvider(config, store, logger);

  const gmail = new GmailService({
    gmailFor: createGmailFactory(config.apiTimeoutMs, version),
    auth,
    logger,
  });
  const docs = new DocsService({
    docsFor: createDocsFactory(config.apiTimeoutMs, version),
    auth,
    config,
    logger,
  });

  return {
    logger,
    store,
    tools: [createGmailSendTool({ gmail, config }), createDocsAppendTool({ docs, config })],
  };
}
