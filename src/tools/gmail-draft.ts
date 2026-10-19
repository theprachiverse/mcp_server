import type { Config } from "../config.js";
import type { GmailService } from "../google/gmail-service.js";
import { emailInputShape as inputShape, parseEmailArgs } from "./gmail-message.js";
import type { ToolDefinition } from "./types.js";

export const GMAIL_DRAFT_DESCRIPTION =
  "Saves an email as a draft in the user's authenticated Gmail account. It NEVER sends anything: " +
  "the message stays in Drafts until the user opens and sends it themselves. " +
  "Takes the same recipients, subject and body as gmail_send_email. " +
  "Calling it twice creates two drafts. This tool cannot read, edit, delete or send existing drafts.";

export function createGmailDraftTool(deps: {
  gmail: Pick<GmailService, "createDraft">;
  config: Pick<Config, "gmailMaxRecipients" | "gmailMaxSubjectChars" | "gmailMaxBodyBytes">;
}): ToolDefinition<typeof inputShape> {
  const { config } = deps;
  return {
    name: "gmail_create_draft",
    title: "Create email draft (Gmail)",
    description: GMAIL_DRAFT_DESCRIPTION,
    inputShape,
    annotations: {
      title: "Create email draft (Gmail)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async handler(args, ctx) {
      const { message, recipientCount, bodyBytes } = parseEmailArgs(args, config);
      ctx.audit.recipient_count = recipientCount;
      ctx.audit.body_bytes = bodyBytes;

      const result = await deps.gmail.createDraft(message);
      return {
        success: true,
        message: "Draft created.",
        draft_id: result.draftId,
        ...(result.messageId ? { message_id: result.messageId } : {}),
      };
    },
  };
}
