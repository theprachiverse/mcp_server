import { z } from "zod";
import type { Config } from "../config.js";
import type { GmailService } from "../google/gmail-service.js";
import { AppError } from "../utils/errors.js";
import {
  assertNoControlChars,
  assertNotBlank,
  assertSingleLine,
  hasDuplicateRecipients,
  toAddressList,
  utf8ByteLength,
} from "../utils/validation.js";
import type { ToolDefinition } from "./types.js";

const addresses = z.union([z.string(), z.array(z.string())]);

const inputShape = {
  to: addresses.describe(
    "Recipient email address, or an array of addresses. Plain addresses only (name@example.com), at least one.",
  ),
  subject: z.string().describe("Email subject. Single line, must not be blank."),
  body: z
    .string()
    .describe("Email body. Plain text unless body_type is 'html'. Must not be blank."),
  cc: addresses.optional().describe("Optional CC address or array of addresses."),
  bcc: addresses.optional().describe("Optional BCC address or array of addresses."),
  body_type: z.enum(["text", "html"]).optional().describe("Format of 'body'. Defaults to 'text'."),
  reply_to: z.string().optional().describe("Optional single Reply-To email address."),
};

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
      const to = toAddressList(args.to, "to");
      if (to.length === 0)
        throw new AppError("INVALID_ARGUMENT", "'to' needs at least one recipient.");
      const cc = toAddressList(args.cc, "cc");
      const bcc = toAddressList(args.bcc, "bcc");
      const replyTo =
        args.reply_to === undefined ? undefined : toAddressList(args.reply_to, "reply_to")[0];

      const total = to.length + cc.length + bcc.length;
      if (total > config.gmailMaxRecipients) {
        throw new AppError(
          "INVALID_ARGUMENT",
          `Too many recipients (${total}). The limit is ${config.gmailMaxRecipients}.`,
        );
      }
      if (hasDuplicateRecipients(to, cc, bcc)) {
        throw new AppError(
          "INVALID_ARGUMENT",
          "The same address appears more than once across 'to', 'cc' and 'bcc'. Remove duplicates.",
        );
      }

      assertNotBlank(args.subject, "subject");
      assertSingleLine(args.subject, "subject");
      assertNoControlChars(args.subject, "subject");
      if (args.subject.length > config.gmailMaxSubjectChars) {
        throw new AppError(
          "INVALID_ARGUMENT",
          `'subject' is too long (limit ${config.gmailMaxSubjectChars} characters).`,
        );
      }
      assertNotBlank(args.body, "body");
      assertNoControlChars(args.body, "body");
      if (utf8ByteLength(args.body) > config.gmailMaxBodyBytes) {
        throw new AppError(
          "INVALID_ARGUMENT",
          `'body' is too large (limit ${config.gmailMaxBodyBytes} bytes).`,
        );
      }

      ctx.audit.recipient_count = total;
      ctx.audit.body_bytes = utf8ByteLength(args.body);

      const result = await deps.gmail.sendEmail({
        to,
        ...(cc.length ? { cc } : {}),
        ...(bcc.length ? { bcc } : {}),
        ...(replyTo ? { replyTo } : {}),
        subject: args.subject,
        body: args.body,
        bodyType: args.body_type ?? "text",
      });
      return {
        success: true,
        message: "Email sent.",
        message_id: result.messageId,
        ...(result.threadId ? { thread_id: result.threadId } : {}),
      };
    },
  };
}
