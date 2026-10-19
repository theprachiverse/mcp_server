import { z } from "zod";
import type { Config } from "../config.js";
import type { DocsService } from "../google/docs-service.js";
import { AppError } from "../utils/errors.js";
import { hashId } from "../utils/logging.js";
import {
  assertNoControlChars,
  assertNotBlank,
  assertSingleLine,
  docUrlFromId,
} from "../utils/validation.js";
import type { ToolDefinition } from "./types.js";

const TITLE_MAX = 200;

const inputShape = {
  title: z
    .string()
    .describe(
      `Title of the new document. Single line, must not be blank, at most ${TITLE_MAX} characters.`,
    ),
  initial_text: z
    .string()
    .optional()
    .describe(
      "Optional text to put in the new document as plain text. Markdown is not converted to formatting.",
    ),
};

export const DOCS_CREATE_DESCRIPTION =
  "Creates a new, empty Google Doc in the authenticated user's Drive, optionally with some initial text, " +
  "and returns its document_id and document_url. Use google_docs_append_text to add more text later. " +
  "Calling it twice creates two documents, even with the same title. " +
  "Text is inserted as plain text; Markdown is not converted to formatting.";

export function createDocsCreateTool(deps: {
  docs: Pick<DocsService, "createDocument">;
  config: Pick<Config, "docsMaxAppendChars">;
}): ToolDefinition<typeof inputShape> {
  return {
    name: "google_docs_create",
    title: "Create Google Doc",
    description: DOCS_CREATE_DESCRIPTION,
    inputShape,
    annotations: {
      title: "Create Google Doc",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async handler(args, ctx) {
      const title = args.title.trim();
      assertNotBlank(title, "title");
      assertSingleLine(title, "title");
      assertNoControlChars(title, "title");
      if (title.length > TITLE_MAX) {
        throw new AppError(
          "INVALID_ARGUMENT",
          `'title' is too long (limit ${TITLE_MAX} characters).`,
        );
      }

      let initialText: string | undefined;
      if (args.initial_text !== undefined && args.initial_text.trim() !== "") {
        initialText = args.initial_text;
        assertNoControlChars(initialText, "initial_text");
        if (initialText.length > deps.config.docsMaxAppendChars) {
          throw new AppError(
            "INVALID_ARGUMENT",
            `'initial_text' is too long (limit ${deps.config.docsMaxAppendChars} characters).`,
          );
        }
        ctx.audit.text_length = initialText.length;
      }

      const result = await deps.docs.createDocument(title, initialText);
      ctx.audit.doc_hash = hashId(result.documentId);
      return {
        success: true,
        message: "Document created.",
        document_id: result.documentId,
        document_url: docUrlFromId(result.documentId),
      };
    },
  };
}
