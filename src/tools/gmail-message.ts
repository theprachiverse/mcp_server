import { z } from "zod";
import type { Config } from "../config.js";
import type { MimeInput } from "../google/mime.js";
import { AppError } from "../utils/errors.js";
import {
  assertNoControlChars,
  assertNotBlank,
  assertSingleLine,
  hasDuplicateRecipients,
  toAddressList,
  utf8ByteLength,
} from "../utils/validation.js";

const addresses = z.union([z.string(), z.array(z.string())]);

/** Input shared by every tool that composes an email (send, draft). */
export const emailInputShape = {
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

export type EmailArgs = z.infer<z.ZodObject<typeof emailInputShape>>;

export interface ParsedEmail {
  message: MimeInput;
  recipientCount: number;
  bodyBytes: number;
}

/** Validates the arguments and builds the message. Throws INVALID_ARGUMENT before any Google call. */
export function parseEmailArgs(
  args: EmailArgs,
  config: Pick<Config, "gmailMaxRecipients" | "gmailMaxSubjectChars" | "gmailMaxBodyBytes">,
): ParsedEmail {
  const to = toAddressList(args.to, "to");
  if (to.length === 0) throw new AppError("INVALID_ARGUMENT", "'to' needs at least one recipient.");
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
  const bodyBytes = utf8ByteLength(args.body);
  if (bodyBytes > config.gmailMaxBodyBytes) {
    throw new AppError(
      "INVALID_ARGUMENT",
      `'body' is too large (limit ${config.gmailMaxBodyBytes} bytes).`,
    );
  }

  return {
    message: {
      to,
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      ...(replyTo ? { replyTo } : {}),
      subject: args.subject,
      body: args.body,
      bodyType: args.body_type ?? "text",
    },
    recipientCount: total,
    bodyBytes,
  };
}
