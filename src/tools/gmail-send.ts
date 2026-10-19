import type { Config } from "../config.js";
import type { GmailService } from "../google/gmail-service.js";
import { emailInputShape as inputShape, parseEmailArgs } from "./gmail-message.js";
import type { ToolDefinition } from "./types.js";

export const GMAIL_SEND_DESCRIPTION =
  "Sends a real email immediately from the user's authenticated Gmail account. This cannot be undone. " +
  "Confirm the recipients, subject and body with the user before calling unless they have explicitly asked you to send it. " +
  "Use only to send a new message; this tool cannot read, search, reply in-thread or attach files.";

export function createGmailSendTool(deps: {
  gmail: Pick<GmailService, "sendEmail">;
  config: Pick<Config, "gmailMaxRecipients" | "gmailMaxSubjectChars" | "gmailMaxBodyBytes">;
}): ToolDefinition<typeof inputShape> {
  const { config } = deps;
  return {
    name: "gmail_send_email",
    title: "Send email (Gmail)",
    description: GMAIL_SEND_DESCRIPTION,
    inputShape,
    annotations: {
      title: "Send email (Gmail)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async handler(args, ctx) {
      const { message, recipientCount, bodyBytes } = parseEmailArgs(args, config);
      ctx.audit.recipient_count = recipientCount;
      ctx.audit.body_bytes = bodyBytes;

      const result = await deps.gmail.sendEmail(message);
      return {
        success: true,
        message: "Email sent.",
        message_id: result.messageId,
        ...(result.threadId ? { thread_id: result.threadId } : {}),
      };
    },
  };
}
