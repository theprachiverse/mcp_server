import type { AuthProvider } from "../auth/google-oauth.js";
import { AppError } from "../utils/errors.js";
import type { Logger } from "../utils/logging.js";
import type { GmailFactory } from "./clients.js";
import { mapGoogleError, wasNeverDelivered } from "./google-errors.js";
import { buildMimeMessage, toGmailRaw, type MimeInput } from "./mime.js";

export interface SendResult {
  messageId: string;
  threadId?: string | undefined;
}

export interface DraftResult {
  draftId: string;
  messageId?: string | undefined;
}

export class GmailService {
  constructor(
    private readonly deps: { gmailFor: GmailFactory; auth: AuthProvider; logger: Logger },
  ) {}

  /**
   * Sends exactly once. There is deliberately NO retry here: Gmail has no idempotency key, so a
   * repeated request after an ambiguous failure could deliver the email twice.
   */
  async sendEmail(message: MimeInput): Promise<SendResult> {
    // Auth (and token refresh) first, so an auth failure is never mistaken for an ambiguous send.
    const oauth = await this.deps.auth.getClient("gmail");
    const raw = toGmailRaw(buildMimeMessage(message));
    const api = this.deps.gmailFor(oauth);

    let result: Awaited<ReturnType<typeof api.send>>;
    try {
      result = await api.send(raw);
    } catch (err) {
      throw mapWriteError(
        err,
        "Gmail may have sent this email. Check the Sent folder before trying again.",
      );
    }
    if (!result.id) {
      throw new AppError(
        "OPERATION_OUTCOME_UNKNOWN",
        "Gmail responded without confirming the message. Check the Sent folder before trying again.",
      );
    }
    return { messageId: result.id, threadId: result.threadId };
  }

  /**
   * Saves a draft exactly once and never sends it. Like sendEmail there is deliberately NO retry:
   * Gmail has no idempotency key, so a repeated request could leave two drafts.
   */
  async createDraft(message: MimeInput): Promise<DraftResult> {
    const oauth = await this.deps.auth.getClient("gmail_draft");
    const raw = toGmailRaw(buildMimeMessage(message));
    const api = this.deps.gmailFor(oauth);

    let result: Awaited<ReturnType<typeof api.createDraft>>;
    try {
      result = await api.createDraft(raw);
    } catch (err) {
      throw mapWriteError(
        err,
        "Gmail may have created this draft. Check Drafts before trying again.",
      );
    }
    if (!result.id) {
      throw new AppError(
        "OPERATION_OUTCOME_UNKNOWN",
        "Gmail responded without confirming the draft. Check Drafts before trying again.",
      );
    }
    return { draftId: result.id, messageId: result.messageId };
  }
}

/** Maps a failed Gmail write; an ambiguous failure becomes OPERATION_OUTCOME_UNKNOWN. */
function mapWriteError(err: unknown, unknownMessage: string): AppError {
  if (wasNeverDelivered(err)) {
    return new AppError("NETWORK_ERROR", undefined, { cause: err, retryable: true });
  }
  const mapped = mapGoogleError(err, { kind: "write" });
  if (mapped.code === "OPERATION_OUTCOME_UNKNOWN") {
    return new AppError("OPERATION_OUTCOME_UNKNOWN", unknownMessage, { cause: err });
  }
  return mapped;
}
