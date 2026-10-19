import { randomUUID } from "node:crypto";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { createServer, type ServerDeps } from "../server.js";
import type { Logger } from "../utils/logging.js";
import { bearerAuth } from "./bearer-auth.js";

export interface HttpAppDeps {
  tools: ServerDeps["tools"];
  logger: Logger;
  version: string;
  authToken: string;
  /** Host names (no ports) accepted in the Host header, to stop DNS rebinding. */
  allowedHosts: readonly string[];
  rateLimitPerMinute: number;
  /** Number of reverse proxies in front of the server (1 on Railway). */
  trustProxy: number;
}

/** Email bodies are capped at 1 MiB by default; leave room for JSON escaping. */
const BODY_LIMIT = "2mb";

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: "2.0",
  error: { code, message },
  id: null,
});

/**
 * Stateless Streamable HTTP: every POST gets its own McpServer and transport, so nothing is shared
 * between requests and a restart or redeploy loses no sessions.
 */
export function createHttpApp(deps: HttpAppDeps): express.Express {
  const { logger } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.trustProxy);

  // Health check: no auth, no Google call, no configuration in the answer. It sits before the Host
  // check because Railway's health checker sends its own Host header.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(hostHeaderValidation([...deps.allowedHosts]));

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: deps.rateLimitPerMinute,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn("http.rate_limited", { ip: req.ip });
      res
        .status(429)
        .json({ error: { code: "RATE_LIMITED", message: "Too many requests. Slow down." } });
    },
  });

  // Order matters: throttle and authenticate before reading (and parsing) the body.
  app.post(
    "/mcp",
    limiter,
    bearerAuth(deps.authToken, logger),
    express.json({ limit: BODY_LIMIT }),
    async (req: Request, res: Response) => {
      const server = createServer({ tools: deps.tools, logger, version: deps.version });
      // No sessionIdGenerator means stateless. JSON replies (not SSE) suit plain request/response tools.
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        // The SDK class types its callbacks as "| undefined", which exactOptionalPropertyTypes rejects.
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        logger.error("http.request_failed", { request_id: randomUUID(), error: err });
        if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, "Internal server error."));
      }
    },
  );

  // Stateless mode has no SSE stream to open and no session to delete.
  const notAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json(jsonRpcError(-32000, "Method not allowed. Use POST."));
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const tooLarge = (err as { status?: unknown })?.status === 413;
    // Parser errors can quote the body, so log only the error type.
    if (!tooLarge) logger.warn("http.bad_request", { error_name: (err as Error)?.name });
    res
      .status(tooLarge ? 413 : 400)
      .json(
        tooLarge
          ? jsonRpcError(-32600, "Request too large.")
          : jsonRpcError(-32700, "Invalid request body."),
      );
  });

  return app;
}
