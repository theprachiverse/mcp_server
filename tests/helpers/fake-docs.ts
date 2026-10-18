import type { DocsPort } from "../../src/google/clients.js";
import type { DocBody, DocsRequest } from "../../src/google/docs-index.js";

/** Builds a Docs `body` from full document text (every paragraph ends with "\n"; empty doc = "\n"). */
export function bodyFromText(text: string): DocBody {
  if (!text.endsWith("\n")) throw new Error("document text must end with a newline");
  const content: NonNullable<DocBody["content"]> = [
    { startIndex: 0, endIndex: 1, sectionBreak: {} },
  ];
  let index = 1;
  for (const para of text.split("\n").slice(0, -1)) {
    const content_ = para + "\n";
    content.push({
      startIndex: index,
      endIndex: index + content_.length,
      paragraph: { elements: [{ textRun: { content: content_ } }] },
    });
    index += content_.length;
  }
  return { content };
}

export class FakeDocsError extends Error {
  constructor(
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    Object.assign(this, extra);
  }
}

export const httpError = (status: number, message = "boom", reason?: string, statusText?: string) =>
  new FakeDocsError(message, {
    response: {
      status,
      data: {
        error: { code: status, message, status: statusText, errors: reason ? [{ reason }] : [] },
      },
    },
  });

export const nodeError = (code: string, message = code) => new FakeDocsError(message, { code });

type Hook = (requests: DocsRequest[]) => void | Promise<void>;

/** In-memory Docs simulator: applies insertText, enforces revision checks, records calls. */
export class FakeDocs implements DocsPort {
  revision = 1;
  getCalls = 0;
  batchCalls: Array<{ requests: DocsRequest[]; requiredRevisionId: string }> = [];
  /** Queue of hooks run at the start of each batchUpdate (throw to simulate failures). */
  beforeBatch: Hook[] = [];
  /** Queue of errors thrown by successive `get` calls (null = succeed). */
  getErrors: Array<Error | null> = [];

  constructor(public text: string) {}

  async get() {
    this.getCalls++;
    const err = this.getErrors.shift();
    if (err) throw err;
    return { revisionId: `rev${this.revision}`, body: bodyFromText(this.text) };
  }

  /** Simulates another user editing the document. */
  externalEdit(newText: string) {
    this.text = newText;
    this.revision++;
  }

  async batchUpdate(_id: string, requests: DocsRequest[], requiredRevisionId: string) {
    this.batchCalls.push({ requests, requiredRevisionId });
    const hook = this.beforeBatch.shift();
    if (hook) await hook(requests);
    if (requiredRevisionId !== `rev${this.revision}`) {
      throw httpError(
        400,
        "Invalid requests: the required revision ID does not match",
        undefined,
        "FAILED_PRECONDITION",
      );
    }
    for (const r of requests) {
      const ins = r.insertText as { location: { index: number }; text: string } | undefined;
      if (!ins) continue;
      const offset = ins.location.index - 1;
      if (offset < 0 || offset > this.text.length - 1) throw httpError(400, "Index out of range");
      this.text = this.text.slice(0, offset) + ins.text + this.text.slice(offset);
    }
    this.revision++;
  }
}
