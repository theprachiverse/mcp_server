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
  resolveDocumentId,
} from "../utils/validation.js";
import type { ToolDefinition } from "./types.js";

const inputShape = {
  document_id: z
    .string()
    .optional()
    .describe("Google Docs document ID. Provide this or 'document_url', not both."),
  document_url: z
    .string()
    .optional()
    .describe(
      "Full https://docs.google.com/document/d/<id>/... link. Provide this or 'document_id', not both.",
    ),
  text: z
    .string()
    .describe(
      "Text to append at the end of the document. Inserted as plain text; must not be blank.",
    ),
  add_separator_newline: z
    .boolean()
    .optional()
    .describe("Default true: leave one blank line between existing content and the new text."),
  heading: z
    .string()
    .optional()
    .describe("Optional single-line heading inserted (as a Heading 2) before the text."),
  insert_timestamp: z
    .boolean()
    .optional()
    .describe(
      "Default false. If true, adds a 'YYYY-MM-DD HH:mm <zone>' line before the text (server-configured time zone, UTC by default).",
    ),
};

export const DOCS_APPEND_DESCRIPTION =
  "Appends text to the end of an existing Google Doc owned by or shared with the authenticated user. " +
  "Existing content is never changed or removed. This modifies the document immediately. " +
  "Provide either 'document_id' or 'document_url'. The tool will not create a document. " +
  "Text is inserted as plain text; Markdown is not converted to formatting.";

const HEADING_MAX = 200;

export function createDocsAppendTool(deps: {
  docs: Pick<DocsService, "appendText">;
  config: Pick<Config, "docsMaxAppendChars">;
}): ToolDefinition<typeof inputShape> {
  return {
    name: "google_docs_append_text",
    title: "Append text to Google Doc",
    description: DOCS_APPEND_DESCRIPTION,
    inputShape,
    annotations: {
      title: "Append text to Google Doc",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async handler(args, ctx) {
      const documentId = resolveDocumentId({
        document_id: args.document_id,
        document_url: args.document_url,
      });
      assertNotBlank(args.text, "text");
      assertNoControlChars(args.text, "text");
      if (args.text.length > deps.config.docsMaxAppendChars) {
        throw new AppError(
          "INVALID_ARGUMENT",
          `'text' is too long (limit ${deps.config.docsMaxAppendChars} characters).`,
        );
      }
      let heading: string | undefined;
      if (args.heading !== undefined && args.heading.trim() !== "") {
        heading = args.heading.trim();
        assertSingleLine(heading, "heading");
        assertNoControlChars(heading, "heading");
        if (heading.length > HEADING_MAX) {
          throw new AppError(
            "INVALID_ARGUMENT",
            `'heading' is too long (limit ${HEADING_MAX} characters).`,
          );
        }
      }

      ctx.audit.doc_hash = hashId(documentId);
      ctx.audit.text_length = args.text.length;

      const result = await deps.docs.appendText({
        documentId,
        text: args.text,
        addSeparatorNewline: args.add_separator_newline ?? true,
        heading,
        insertTimestamp: args.insert_timestamp ?? false,
      });
      return {
        success: true,
        message: result.verified
          ? "Text appended (confirmed after a connection problem)."
          : "Text appended.",
        document_id: result.documentId,
        document_url: docUrlFromId(result.documentId),
        appended_characters: result.appendedCharacters,
      };
    },
  };
}
