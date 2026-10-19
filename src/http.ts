import type http from "node:http";
import { seedTokenStore, TokenSeedError } from "./auth/token-store.js";
import { createRuntime, readVersion } from "./bootstrap.js";
import { ConfigError, findProjectRoot, loadConfig, loadDotEnv } from "./config.js";
import { createHttpApp } from "./http/app.js";

const MIN_AUTH_TOKEN_CHARS = 32;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function fail(message: string): never {
  process.stderr.write(`google-workspace-mcp: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const root = findProjectRoot();
  const version = readVersion(root);

  let config;
  try {
    loadDotEnv(root);
    config = loadConfig(process.env, root);
  } catch (err) {
    fail(err instanceof ConfigError ? err.message : "failed to load configuration");
  }

  // The endpoint is public and the tools send real email, so refuse to start without a strong secret.
  const authToken = config.mcpAuthToken;
  if (!authToken || authToken.length < MIN_AUTH_TOKEN_CHARS) {
    // Report only the length and the names of similar variables (never values), to separate
    // "not set on this service" from "set but too short" and from a misspelled name.
    const similar = Object.keys(process.env).filter((k) => /^MCP_|TOKEN/i.test(k));
    const state = authToken
      ? `is set but only ${authToken.length} characters long`
      : "is not set (or is empty)";
    fail(
      `MCP_AUTH_TOKEN ${state}; at least ${MIN_AUTH_TOKEN_CHARS} are required. ` +
        `Variables seen with similar names: ${similar.length ? similar.map((k) => JSON.stringify(k)).join(", ") : "none"}. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }

  const { logger, store, tools } = createRuntime(config, version);

  let tokenSeed: "seeded" | "exists" | "not_configured" = "not_configured";
  if (config.googleTokenB64) {
    try {
      tokenSeed = seedTokenStore(store, config.googleTokenB64);
    } catch (err) {
      fail(err instanceof TokenSeedError ? err.message : "could not write the Google token file.");
    }
  }

  const allowedHosts = [...new Set([...LOCAL_HOSTS, ...config.mcpAllowedHosts])];
  if (config.mcpAllowedHosts.length === 0) {
    logger.warn("http.allowed_hosts_empty", {
      hint: "Set MCP_ALLOWED_HOSTS to the public domain, or generate a Railway domain.",
    });
  }

  const app = createHttpApp({
    tools,
    logger,
    version,
    authToken,
    allowedHosts,
    rateLimitPerMinute: config.mcpRateLimitPerMinute,
    trustProxy: config.mcpTrustProxy,
  });

  const server: http.Server = app.listen(config.port, "0.0.0.0");
  server.on("error", (error) => {
    logger.error("server.listen_failed", { error });
    process.exit(1);
  });
  server.on("listening", () => {
    logger.info("server.started", {
      transport: "http",
      version,
      node: process.version,
      port: config.port,
      allowed_hosts: allowedHosts.length,
      credentials_file_present: store.mtimeMs() !== null,
      credentials_seed: tokenSeed,
    });
  });

  const shutdown = (signal: string) => {
    logger.info("server.stopping", { signal });
    // Give in-flight requests a moment, then leave regardless.
    setTimeout(() => process.exit(0), 10_000).unref();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

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
