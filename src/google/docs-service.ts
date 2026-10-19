import type { AuthProvider } from "../auth/google-oauth.js";
import type { Config } from "../config.js";
import { AppError } from "../utils/errors.js";
import { hashId, type Logger } from "../utils/logging.js";
import { withRetry, type RetryOptions } from "../utils/retry.js";
import type { DocsFactory, DocsPort } from "./clients.js";
import { documentEndsWith, planAppend } from "./docs-index.js";
import {
  isAmbiguousWriteFailure,
  isRetryableRead,
  isRevisionMismatch,
  mapGoogleError,
  retryAfterMsFromError,
  wasNeverDelivered,
} from "./google-errors.js";

export interface AppendInput {
  documentId: string;
  text: string;
  addSeparatorNewline: boolean;
  heading?: string | undefined;
  insertTimestamp: boolean;
}

export interface AppendResult {
  documentId: string;
  appendedCharacters: number;
  verified: boolean;
}

export interface CreateResult {
  documentId: string;
  appendedCharacters: number;
}

export interface DocsServiceDeps {
  docsFor: DocsFactory;
  auth: AuthProvider;
  config: Pick<Config, "docsMaxWriteAttempts" | "docsTimestampTimezone">;
  logger: Logger;
  now?: () => Date;
  retry?: Partial<Pick<RetryOptions, "sleep" | "random" | "baseMs" | "maxMs">>;
}

export class DocsService {
  constructor(private readonly deps: DocsServiceDeps) {}

  /**
   * Creates a new, empty document, optionally followed by an initial append. The create call is made
   * exactly once: Docs has no idempotency key, so a repeat after an ambiguous failure could leave
   * two documents with the same title.
   */
  async createDocument(title: string, initialText?: string): Promise<CreateResult> {
    const { logger } = this.deps;
    const oauth = await this.deps.auth.getClient("docs");
    const api = this.deps.docsFor(oauth);

    let created: Awaited<ReturnType<DocsPort["create"]>>;
    try {
      created = await api.create(title);
    } catch (err) {
      if (wasNeverDelivered(err)) {
        throw new AppError("NETWORK_ERROR", undefined, { cause: err, retryable: true });
      }
      const mapped = mapGoogleError(err, { kind: "write" });
      if (mapped.code === "OPERATION_OUTCOME_UNKNOWN") {
        throw new AppError(
          "OPERATION_OUTCOME_UNKNOWN",
          "Google may have created this document. Check Google Drive for a doc with this title before retrying.",
          { cause: err },
        );
      }
      throw mapped;
    }
    const documentId = created.documentId;
    if (!documentId) {
      throw new AppError(
        "OPERATION_OUTCOME_UNKNOWN",
        "Google responded without confirming the document. Check Google Drive for a doc with this title before retrying.",
      );
    }
    logger.info("docs.create.created", { doc_hash: hashId(documentId) });

    if (initialText === undefined) return { documentId, appendedCharacters: 0 };
    try {
      const appended = await this.appendText({
        documentId,
        text: initialText,
        addSeparatorNewline: false,
        insertTimestamp: false,
      });
      return { documentId, appendedCharacters: appended.appendedCharacters };
    } catch (err) {
      // The empty document exists now, so a plain retry of the create would leave a duplicate.
      const cause = err instanceof AppError ? err : mapGoogleError(err, { kind: "write" });
      throw new AppError(
        cause.code,
        `The document was created (document_id: ${documentId}) but the initial text could not be added. Use google_docs_append_text with this document_id instead of creating it again.`,
        { cause: err, retryable: false },
      );
    }
  }

  /** Appends text at the end of an existing document. Never creates or replaces anything. */
  async appendText(input: AppendInput): Promise<AppendResult> {
    const { logger, config } = this.deps;
    const oauth = await this.deps.auth.getClient("docs");
    const api = this.deps.docsFor(oauth);
    const doc = hashId(input.documentId);

    for (let attempt = 1; attempt <= config.docsMaxWriteAttempts; attempt++) {
      const snapshot = await this.readDocument(api, input.documentId);
      const plan = planAppend(
        snapshot.body,
        {
          text: input.text,
          addSeparatorNewline: input.addSeparatorNewline,
          heading: input.heading,
          insertTimestamp: input.insertTimestamp,
        },
        (this.deps.now ?? (() => new Date()))(),
        config.docsTimestampTimezone,
      );

      try {
        await api.batchUpdate(input.documentId, plan.requests, snapshot.revisionId);
        logger.info("docs.append.written", { doc_hash: doc, attempt });
        return {
          documentId: input.documentId,
          appendedCharacters: plan.insertText.length,
          verified: false,
        };
      } catch (err) {
        if (isRevisionMismatch(err)) {
          // Google applies nothing when the revision does not match, so re-planning is safe.
          logger.info("docs.append.revision_conflict", { doc_hash: doc, attempt });
          continue;
        }
        if (isAmbiguousWriteFailure(err)) {
          const outcome = await this.checkAfterAmbiguousFailure(
            api,
            input.documentId,
            snapshot.revisionId,
            plan.insertText,
          );
          logger.warn("docs.append.ambiguous", { doc_hash: doc, attempt, outcome, error: err });
          if (outcome === "applied") {
            return {
              documentId: input.documentId,
              appendedCharacters: plan.insertText.length,
              verified: true,
            };
          }
          if (outcome === "not_applied") continue;
          throw new AppError(
            "OPERATION_OUTCOME_UNKNOWN",
            "The document may or may not have been updated (the connection failed and the document also changed). Open the document to check before trying again.",
            { cause: err },
          );
        }
        throw mapGoogleError(err, { kind: "write" });
      }
    }
    throw new AppError(
      "GOOGLE_API_ERROR",
      "The document kept changing while appending. Nothing was added; try again shortly.",
      { retryable: true },
    );
  }

  private async readDocument(api: DocsPort, documentId: string) {
    try {
      return await withRetry(() => api.get(documentId), {
        maxAttempts: 3,
        baseMs: this.deps.retry?.baseMs ?? 500,
        maxMs: this.deps.retry?.maxMs ?? 8000,
        isRetryable: isRetryableRead,
        retryAfterMs: retryAfterMsFromError,
        ...(this.deps.retry?.sleep ? { sleep: this.deps.retry.sleep } : {}),
        ...(this.deps.retry?.random ? { random: this.deps.retry.random } : {}),
      });
    } catch (err) {
      throw mapGoogleError(err, { kind: "read" });
    }
  }

  /** After a timeout/5xx on the write, re-read the document to learn whether it was applied. */
  private async checkAfterAmbiguousFailure(
    api: DocsPort,
    documentId: string,
    revisionBefore: string,
    insertText: string,
  ): Promise<"applied" | "not_applied" | "unknown"> {
    try {
      const after = await api.get(documentId);
      if (after.revisionId === revisionBefore) return "not_applied";
      return documentEndsWith(after.body, insertText) ? "applied" : "unknown";
    } catch {
      return "unknown";
    }
  }
}
