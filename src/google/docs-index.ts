import { AppError } from "../utils/errors.js";

/** Minimal slice of the Docs API `Body` that this module needs. */
export interface DocElement {
  startIndex?: number | null;
  endIndex?: number | null;
  paragraph?: { elements?: Array<{ textRun?: { content?: string | null } | null }> | null } | null;
  sectionBreak?: object | null;
  table?: object | null;
}
export interface DocBody {
  content?: DocElement[] | null;
}

export interface BodyAnalysis {
  /** Index just before the protected final newline. */
  insertIndex: number;
  /** Number of trailing paragraphs that are exactly "\n". */
  trailingEmptyParagraphs: number;
  /** True when the body has no content apart from the required empty paragraph. */
  isEmpty: boolean;
}

function paragraphText(el: DocElement): string {
  return (el.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
}

function fail(message: string): never {
  throw new AppError("GOOGLE_API_ERROR", message);
}

export function analyzeBody(body: DocBody): BodyAnalysis {
  const content = body.content ?? [];
  const last = content[content.length - 1];
  if (!last || !last.paragraph || typeof last.endIndex !== "number") {
    return fail("Unexpected document structure returned by Google Docs. Nothing was changed.");
  }
  const insertIndex = last.endIndex - 1;
  if (insertIndex < 1)
    fail("Unexpected document structure returned by Google Docs. Nothing was changed.");

  let trailing = 0;
  for (let i = content.length - 1; i >= 0; i--) {
    const el = content[i]!;
    if (el.paragraph && paragraphText(el) === "\n") trailing++;
    else break;
  }
  const meaningful = content.filter((el) => !el.sectionBreak);
  const isEmpty = meaningful.length === 1 && trailing === 1;
  return { insertIndex, trailingEmptyParagraphs: trailing, isEmpty };
}

export interface AppendOptions {
  text: string;
  addSeparatorNewline: boolean;
  heading?: string | undefined;
  insertTimestamp: boolean;
}

export type DocsRequest = Record<string, unknown>;

export interface AppendPlan {
  insertIndex: number;
  insertText: string;
  requests: DocsRequest[];
}

/** Separator prefix per architecture §8.3. */
export function separatorPrefix(a: BodyAnalysis, addSeparator: boolean): string {
  if (a.isEmpty) return "";
  if (a.trailingEmptyParagraphs >= 2) return "";
  if (a.trailingEmptyParagraphs === 1) return addSeparator ? "\n" : "";
  return addSeparator ? "\n\n" : "\n";
}

export function formatTimestamp(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

export function normalizeAppendText(text: string): string {
  return text.replace(/\r\n|\r/g, "\n").replace(/\n+$/, "");
}

/** Computes the text to insert and the batchUpdate requests, all relative to this revision. */
export function planAppend(
  body: DocBody,
  opts: AppendOptions,
  now: Date,
  timeZone: string,
): AppendPlan {
  const analysis = analyzeBody(body);
  const { insertIndex } = analysis;
  const prefix = separatorPrefix(analysis, opts.addSeparatorNewline);
  const timestamp = opts.insertTimestamp ? formatTimestamp(now, timeZone) + "\n" : "";
  const heading = opts.heading ? opts.heading + "\n" : "";
  const insertText = prefix + timestamp + heading + normalizeAppendText(opts.text);

  const requests: DocsRequest[] = [
    { insertText: { location: { index: insertIndex }, text: insertText } },
  ];

  // New paragraphs inherit the style of the paragraph they split from (bullets, headings, bold...).
  // Reset the inserted range. When a prefix is present its first "\n" closes the existing last
  // paragraph, which must keep its own style, so the reset starts one character later.
  const resetStart = prefix.length > 0 ? insertIndex + 1 : insertIndex;
  const afterEnd = insertIndex + insertText.length + 1; // end of the (new) last paragraph
  if (resetStart < afterEnd - 1) {
    const paraRange = { startIndex: resetStart, endIndex: afterEnd };
    requests.push(
      { deleteParagraphBullets: { range: paraRange } },
      {
        updateParagraphStyle: {
          range: paraRange,
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          fields: "namedStyleType",
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: resetStart, endIndex: afterEnd - 1 },
          textStyle: {},
          fields: "*",
        },
      },
    );
  }
  if (opts.heading) {
    const start = insertIndex + prefix.length + timestamp.length;
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: start + opts.heading.length + 1 },
        paragraphStyle: { namedStyleType: "HEADING_2" },
        fields: "namedStyleType",
      },
    });
  }
  return { insertIndex, insertText, requests };
}

/** Plain text of the body (text runs only). Used to verify an ambiguous write. */
export function bodyPlainText(body: DocBody): string {
  return (body.content ?? []).map((el) => (el.paragraph ? paragraphText(el) : "")).join("");
}

/** True when the document currently ends with exactly the text we tried to insert. */
export function documentEndsWith(body: DocBody, insertText: string): boolean {
  return bodyPlainText(body).endsWith(insertText + "\n");
}
