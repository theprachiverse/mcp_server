import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toPublicError } from "./utils/errors.js";
import type { Logger } from "./utils/logging.js";
import {
  resultOutputShape,
  type ToolContext,
  type ToolDefinition,
  type ToolResultPayload,
} from "./tools/types.js";

export interface ServerDeps {
  tools: ToolDefinition<any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  logger: Logger;
  version: string;
}

/** Runs a tool handler. Never throws: every failure becomes the FR-5 error envelope. */
export async function runTool(
  def: ToolDefinition<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  args: unknown,
  logger: Logger,
): Promise<{ result: ToolResultPayload; requestId: string }> {
  const ctx: ToolContext = { requestId: randomUUID(), audit: {} };
  const started = Date.now();
  let result: ToolResultPayload;
  try {
    result = await def.handler(args as Record<string, unknown>, ctx);
  } catch (err) {
    const pub = toPublicError(err);
    result = { success: false, error: pub };
    if (pub.code === "INTERNAL_ERROR")
      logger.error("tool.internal_error", { request_id: ctx.requestId, error: err });
    else
      logger.debug("tool.failure_cause", {
        request_id: ctx.requestId,
        error: (err as Error)?.cause,
      });
  }
  logger.info("tool.call", {
    request_id: ctx.requestId,
    tool: def.name,
    outcome: result.success ? "success" : "failure",
    ...(result.success ? {} : { error_code: result.error.code }),
    duration_ms: Date.now() - started,
    ...ctx.audit,
  });
  return { result, requestId: ctx.requestId };
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "google-workspace-mcp", version: deps.version });

  for (const def of deps.tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputShape,
        outputSchema: resultOutputShape,
        annotations: def.annotations,
      },
      async (args: unknown) => {
        const { result, requestId } = await runTool(def, args, deps.logger);
        const structured = { ...result, request_id: requestId };
        const summary = result.success
          ? result.message
          : `${result.error.code}: ${result.error.message}`;
        return {
          content: [{ type: "text" as const, text: `${summary}\n${JSON.stringify(structured)}` }],
          structuredContent: structured,
          isError: !result.success,
        };
      },
    );
  }
  return server;
}
