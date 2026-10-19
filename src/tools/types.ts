import { z } from "zod";
import { ERROR_CODES, type PublicError } from "../utils/errors.js";

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export type SuccessPayload = { success: true; message: string } & Record<string, unknown>;
export type FailurePayload = { success: false; error: PublicError };
export type ToolResultPayload = SuccessPayload | FailurePayload;

/** Context passed to every handler. */
export interface ToolContext {
  requestId: string;
  /** Extra non-sensitive fields to include in the audit log line (counts, hashes). */
  audit: Record<string, unknown>;
}

/** MCP-agnostic tool definition. server.ts is the only code that registers these with the SDK. */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputShape: Shape;
  annotations: ToolAnnotations;
  handler(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<SuccessPayload>;
}

/**
 * One flat object valid for both outcomes. Clients may validate structuredContent against this
 * even for error results, so success-only schemas would break failures.
 */
export const resultOutputShape = {
  success: z.boolean().describe("true when the action completed"),
  message: z.string().optional().describe("Short human-readable summary"),
  message_id: z
    .string()
    .optional()
    .describe("Gmail message ID (gmail_send_email, gmail_create_draft)"),
  thread_id: z.string().optional().describe("Gmail thread ID (gmail_send_email)"),
  draft_id: z.string().optional().describe("Gmail draft ID (gmail_create_draft)"),
  document_id: z
    .string()
    .optional()
    .describe("Google Docs document ID (google_docs_append_text, google_docs_create)"),
  document_url: z
    .string()
    .optional()
    .describe("Link to the document (google_docs_append_text, google_docs_create)"),
  appended_characters: z
    .number()
    .optional()
    .describe("Characters inserted (google_docs_append_text)"),
  request_id: z.string().optional().describe("Correlation ID to quote when reporting a problem"),
  error: z
    .object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      retryable: z.boolean().describe("Whether trying again is safe"),
    })
    .optional()
    .describe("Present only when success is false"),
};
