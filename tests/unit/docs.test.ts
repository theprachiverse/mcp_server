import { describe, expect, it } from "vitest";
import type { AuthProvider } from "../../src/auth/google-oauth.js";
import {
  analyzeBody,
  bodyPlainText,
  documentEndsWith,
  formatTimestamp,
  planAppend,
} from "../../src/google/docs-index.js";
import { DocsService } from "../../src/google/docs-service.js";
import { nullLogger } from "../../src/utils/logging.js";
import { bodyFromText, FakeDocs, httpError, nodeError } from "../helpers/fake-docs.js";

const NOW = new Date("2026-03-04T15:07:00Z");
const opts = { addSeparatorNewline: true, insertTimestamp: false };
const plan = (text: string, doc: string, o: Partial<Parameters<typeof planAppend>[1]> = {}) =>
  planAppend(bodyFromText(doc), { text, ...opts, ...o }, NOW, "UTC");

/** Applies only the insertText request, like the simulator. */
const apply = (doc: string, p: ReturnType<typeof plan>) => {
  const off = p.insertIndex - 1;
  return doc.slice(0, off) + p.insertText + doc.slice(off);
};

describe("analyzeBody", () => {
  it("handles an empty document", () => {
    expect(analyzeBody(bodyFromText("\n"))).toEqual({
      insertIndex: 1,
      trailingEmptyParagraphs: 1,
      isEmpty: true,
    });
  });
  it("never inserts at a fixed index", () => {
    expect(analyzeBody(bodyFromText("Hello\n")).insertIndex).toBe(6);
    expect(analyzeBody(bodyFromText("Hello\nWorld\n")).insertIndex).toBe(12);
  });
  it("counts trailing empty paragraphs", () => {
    expect(analyzeBody(bodyFromText("A\n\n")).trailingEmptyParagraphs).toBe(1);
    expect(analyzeBody(bodyFromText("A\n\n\n\n")).trailingEmptyParagraphs).toBe(3);
  });
  it("counts UTF-16 units for emoji and CJK", () => {
    // "😀" is 2 UTF-16 units; "日本" is 2.
    expect(analyzeBody(bodyFromText("😀日本\n")).insertIndex).toBe(1 + 4);
  });
  it("rejects a body that does not end in a paragraph", () => {
    expect(() =>
      analyzeBody({ content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }] }),
    ).toThrow(/Unexpected document/);
    expect(() => analyzeBody({})).toThrow();
  });
});

describe("planAppend separator rules", () => {
  const cases: Array<[string, string, boolean, string]> = [
    ["empty doc", "\n", true, "New\n"],
    ["empty doc, no sep", "\n", false, "New\n"],
    ["non-empty last paragraph", "Old\n", true, "Old\n\nNew\n"],
    ["non-empty, no separator", "Old\n", false, "Old\nNew\n"],
    ["one trailing blank", "Old\n\n", true, "Old\n\nNew\n"],
    ["one trailing blank, no sep", "Old\n\n", false, "Old\nNew\n"],
    ["two trailing blanks", "Old\n\n\n", true, "Old\n\nNew\n"],
    ["three trailing blanks", "Old\n\n\n\n", true, "Old\n\n\nNew\n"],
  ];
  it.each(cases)("%s", (_n, doc, sep, expected) => {
    expect(apply(doc, plan("New", doc, { addSeparatorNewline: sep }))).toBe(expected);
  });

  it("preserves all existing content as prefix/suffix", () => {
    const doc = "Title\nBody line\n";
    const result = apply(doc, plan("More", doc));
    expect(result.startsWith("Title\nBody line")).toBe(true);
    expect(result.endsWith("More\n")).toBe(true);
  });
  it("strips trailing newlines and normalises CRLF in the appended text", () => {
    expect(apply("A\n", plan("x\r\ny\n\n", "A\n"))).toBe("A\n\nx\ny\n");
  });
});

describe("planAppend heading, timestamp and style reset", () => {
  it("places timestamp and heading before the text", () => {
    const p = plan("Body", "Old\n", { heading: "Weekly", insertTimestamp: true });
    expect(p.insertText).toBe("\n\n2026-03-04 15:07 UTC\nWeekly\nBody");
  });
  it("styles exactly the heading line as HEADING_2", () => {
    const doc = "Old\n";
    const p = plan("Body", doc, { heading: "Weekly" });
    const finalText = apply(doc, p);
    const h = (
      p.requests.at(-1) as {
        updateParagraphStyle: {
          range: { startIndex: number; endIndex: number };
          paragraphStyle: { namedStyleType: string };
        };
      }
    ).updateParagraphStyle;
    expect(h.paragraphStyle.namedStyleType).toBe("HEADING_2");
    expect(finalText.slice(h.range.startIndex - 1, h.range.endIndex - 1)).toBe("Weekly\n");
  });
  it("computes heading ranges correctly after emoji", () => {
    const doc = "😀\n";
    const p = plan("B", doc, { heading: "H" });
    const finalText = apply(doc, p);
    const h = (
      p.requests.at(-1) as {
        updateParagraphStyle: { range: { startIndex: number; endIndex: number } };
      }
    ).updateParagraphStyle;
    expect(finalText.slice(h.range.startIndex - 1, h.range.endIndex - 1)).toBe("H\n");
  });
  it("resets inherited bullets/styles only over the new range", () => {
    const doc = "Item\n";
    const p = plan("Body", doc);
    const names = p.requests.map((r) => Object.keys(r)[0]);
    expect(names).toEqual([
      "insertText",
      "deleteParagraphBullets",
      "updateParagraphStyle",
      "updateTextStyle",
    ]);
    const range = (p.requests[1] as { deleteParagraphBullets: { range: { startIndex: number } } })
      .deleteParagraphBullets.range;
    // Prefix is non-empty, so the existing last paragraph (index 1..5) is untouched.
    expect(range.startIndex).toBeGreaterThan(p.insertIndex);
  });
  it("starts the reset at the insert point when no prefix is needed", () => {
    const p = plan("Body", "\n");
    const range = (p.requests[1] as { deleteParagraphBullets: { range: { startIndex: number } } })
      .deleteParagraphBullets.range;
    expect(range.startIndex).toBe(1);
  });
});

describe("formatTimestamp", () => {
  it("formats in UTC and in other zones", () => {
    expect(formatTimestamp(NOW, "UTC")).toBe("2026-03-04 15:07 UTC");
    expect(formatTimestamp(NOW, "Asia/Kolkata")).toMatch(/^2026-03-04 20:37 /);
  });
});

describe("documentEndsWith", () => {
  it("matches only when the document tail is exactly the inserted text", () => {
    const body = bodyFromText("Old\n\nNew text\n");
    expect(bodyPlainText(body)).toBe("Old\n\nNew text\n");
    expect(documentEndsWith(body, "\n\nNew text")).toBe(true);
    expect(documentEndsWith(body, "Other")).toBe(false);
  });
});

// ------------------------------------------------------------------ service

const auth: AuthProvider = { getClient: async () => ({}) as never };
const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abc";
const input = { documentId: ID, text: "New", addSeparatorNewline: true, insertTimestamp: false };

function service(fake: FakeDocs, attempts = 3) {
  return new DocsService({
    docsFor: () => fake,
    auth,
    config: { docsMaxWriteAttempts: attempts, docsTimestampTimezone: "UTC" },
    logger: nullLogger,
    now: () => NOW,
    retry: { sleep: async () => {}, random: () => 0 },
  });
}

describe("DocsService.appendText", () => {
  it("appends once and preserves existing content", async () => {
    const fake = new FakeDocs("Old line\n");
    const r = await service(fake).appendText(input);
    expect(fake.text).toBe("Old line\n\nNew\n");
    expect(fake.batchCalls).toHaveLength(1);
    expect(fake.batchCalls[0]!.requiredRevisionId).toBe("rev1");
    expect(r).toMatchObject({ documentId: ID, verified: false });
  });

  it("re-reads and succeeds after a revision conflict, without duplicating", async () => {
    const fake = new FakeDocs("Old\n");
    fake.beforeBatch.push(() => fake.externalEdit("Old\nEdited by someone\n"));
    await service(fake).appendText(input);
    expect(fake.text).toBe("Old\nEdited by someone\n\nNew\n");
    expect(fake.text.match(/New/g)).toHaveLength(1);
    expect(fake.batchCalls).toHaveLength(2);
  });

  it("gives up with a retryable error when the document keeps changing", async () => {
    const fake = new FakeDocs("Old\n");
    for (let i = 0; i < 3; i++) fake.beforeBatch.push(() => fake.externalEdit(`Old${i}\n`));
    await expect(service(fake).appendText(input)).rejects.toMatchObject({
      code: "GOOGLE_API_ERROR",
      retryable: true,
    });
    expect(fake.text).not.toContain("New");
  });

  it("retries after a timeout when the revision is unchanged (write not applied)", async () => {
    const fake = new FakeDocs("Old\n");
    fake.beforeBatch.push(() => {
      throw nodeError("ETIMEDOUT");
    });
    await service(fake).appendText(input);
    expect(fake.text.match(/New/g)).toHaveLength(1);
    expect(fake.batchCalls).toHaveLength(2);
  });

  it("detects an applied write after a lost response and does not insert again", async () => {
    const fake = new FakeDocs("Old\n");
    const realBatch = fake.batchUpdate.bind(fake);
    fake.batchUpdate = async (...a) => {
      await realBatch(...a);
      throw nodeError("ECONNRESET");
    };
    const r = await service(fake).appendText(input);
    expect(r.verified).toBe(true);
    expect(fake.text.match(/New/g)).toHaveLength(1);
    expect(fake.batchCalls).toHaveLength(1);
  });

  it("returns OPERATION_OUTCOME_UNKNOWN when it cannot tell what happened", async () => {
    const fake = new FakeDocs("Old\n");
    fake.beforeBatch.push(() => {
      fake.externalEdit("Totally different\n");
      throw httpError(503);
    });
    await expect(service(fake).appendText(input)).rejects.toMatchObject({
      code: "OPERATION_OUTCOME_UNKNOWN",
      retryable: false,
    });
    expect(fake.batchCalls).toHaveLength(1);
  });

  it("returns OPERATION_OUTCOME_UNKNOWN when verification itself fails", async () => {
    const fake = new FakeDocs("Old\n");
    fake.beforeBatch.push(() => {
      fake.getErrors.push(nodeError("ETIMEDOUT"));
      throw nodeError("ETIMEDOUT");
    });
    // first get() inside the loop already succeeded; the next get (verification) fails
    await expect(service(fake).appendText(input)).rejects.toMatchObject({
      code: "OPERATION_OUTCOME_UNKNOWN",
    });
  });

  it("makes at most one write per revision", async () => {
    const fake = new FakeDocs("Old\n");
    fake.beforeBatch.push(() => fake.externalEdit("Old2\n"));
    await service(fake).appendText(input);
    const revs = fake.batchCalls.map((c) => c.requiredRevisionId);
    expect(new Set(revs).size).toBe(revs.length);
  });

  it.each([
    [httpError(403, "x", "forbidden"), "PERMISSION_DENIED"],
    [httpError(404), "RESOURCE_NOT_FOUND"],
    [httpError(429), "RATE_LIMITED"],
  ])("maps write failure %# to %s without retrying", async (err, code) => {
    const fake = new FakeDocs("Old\n");
    fake.beforeBatch.push(() => {
      throw err;
    });
    await expect(service(fake).appendText(input)).rejects.toMatchObject({ code });
    expect(fake.batchCalls).toHaveLength(1);
  });

  it("maps read failures and retries transient reads", async () => {
    const fake = new FakeDocs("Old\n");
    fake.getErrors.push(httpError(503), null);
    await service(fake).appendText(input);
    expect(fake.getCalls).toBe(2);

    const missing = new FakeDocs("Old\n");
    missing.getErrors.push(httpError(404));
    await expect(service(missing).appendText(input)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    expect(missing.batchCalls).toHaveLength(0);
  });

  it("surfaces auth failures before touching the document", async () => {
    const fake = new FakeDocs("Old\n");
    const svc = new DocsService({
      docsFor: () => fake,
      auth: {
        getClient: async () => {
          throw Object.assign(new Error("x"), { code: "AUTH_REQUIRED" });
        },
      },
      config: { docsMaxWriteAttempts: 3, docsTimestampTimezone: "UTC" },
      logger: nullLogger,
    });
    await expect(svc.appendText(input)).rejects.toThrow();
    expect(fake.getCalls).toBe(0);
  });

  it("never exposes a create method", () => {
    expect(
      Object.getOwnPropertyNames(DocsService.prototype).filter((n) =>
        /create|replace|delete/i.test(n),
      ),
    ).toEqual([]);
  });
});
