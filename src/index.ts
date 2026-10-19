import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRuntime, readVersion } from "./bootstrap.js";
import { ConfigError, findProjectRoot, loadConfig, loadDotEnv } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const root = findProjectRoot();
  const version = readVersion(root);

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

  const { logger, store, tools } = createRuntime(config, version);
  const server = createServer({ tools, logger, version });

  await server.connect(new StdioServerTransport());
  logger.info("server.started", {
    version,
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
