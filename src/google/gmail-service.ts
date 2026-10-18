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
      if (wasNeverDelivered(err)) {
        throw new AppError("NETWORK_ERROR", undefined, { cause: err, retryable: true });
      }
      const mapped = mapGoogleError(err, { kind: "write" });
      if (mapped.code === "OPERATION_OUTCOME_UNKNOWN") {
        throw new AppError(
          "OPERATION_OUTCOME_UNKNOWN",
          "Gmail may have sent this email. Check the Sent folder before trying again.",
          { cause: err },
        );
      }
      throw mapped;
    }
    if (!result.id) {
      throw new AppError(
        "OPERATION_OUTCOME_UNKNOWN",
        "Gmail responded without confirming the message. Check the Sent folder before trying again.",
      );
    }
    return { messageId: result.id, threadId: result.threadId };
  }
}
