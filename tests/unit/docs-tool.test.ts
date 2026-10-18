import { describe, expect, it, vi } from "vitest";
import { createDocsAppendTool } from "../../src/tools/docs-append.js";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abc";
const appendText = vi.fn(async (i: { documentId: string }) => ({
  documentId: i.documentId,
  appendedCharacters: 5,
  verified: false,
}));
const tool = createDocsAppendTool({ docs: { appendText }, config: { docsMaxAppendChars: 100 } });
const run = (args: Record<string, unknown>) =>
  tool.handler({ document_id: ID, text: "hello", ...args } as never, { requestId: "r", audit: {} });

describe("google_docs_append_text tool handler", () => {
  it("appends by ID with defaults and rebuilds the URL", async () => {
    appendText.mockClear();
    const r = await run({});
    expect(r).toMatchObject({
      success: true,
      document_id: ID,
      document_url: `https://docs.google.com/document/d/${ID}/edit`,
      appended_characters: 5,
    });
    expect(appendText).toHaveBeenCalledWith({
      documentId: ID,
      text: "hello",
      addSeparatorNewline: true,
      heading: undefined,
      insertTimestamp: false,
    });
  });
  it("accepts a document URL", async () => {
    appendText.mockClear();
    await run({
      document_id: undefined,
      document_url: `https://docs.google.com/document/d/${ID}/edit?tab=t.0`,
    });
    expect(appendText.mock.calls[0]![0].documentId).toBe(ID);
  });
  it("passes options through", async () => {
    appendText.mockClear();
    await run({ add_separator_newline: false, heading: " Weekly ", insert_timestamp: true });
    expect(appendText).toHaveBeenCalledWith(
      expect.objectContaining({
        addSeparatorNewline: false,
        heading: "Weekly",
        insertTimestamp: true,
      }),
    );
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["neither id nor url", { document_id: undefined }, /exactly one/],
    [
      "both id and url",
      { document_url: `https://docs.google.com/document/d/${ID}/edit` },
      /exactly one/,
    ],
    ["bad id", { document_id: "../../x" }, /not a valid/],
    [
      "foreign domain",
      { document_id: undefined, document_url: `https://evil.com/document/d/${ID}/edit` },
      /docs\.google\.com/,
    ],
    [
      "sheets link",
      { document_id: undefined, document_url: `https://docs.google.com/spreadsheets/d/${ID}/edit` },
      /Sheets/,
    ],
    ["blank text", { text: "  \n " }, /text/],
    ["long text", { text: "x".repeat(101) }, /too long/],
    ["control chars", { text: "a\u0000b" }, /control/],
    ["multi-line heading", { heading: "a\nb" }, /single line/],
  ])("rejects %s", async (_n, args, re) => {
    appendText.mockClear();
    await expect(run(args)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringMatching(re),
    });
    expect(appendText).not.toHaveBeenCalled();
  });

  it("flags verified writes in the message", async () => {
    appendText.mockResolvedValueOnce({ documentId: ID, appendedCharacters: 1, verified: true });
    expect((await run({})).message).toMatch(/confirmed/);
  });
});
