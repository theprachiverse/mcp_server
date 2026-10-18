import { describe, expect, it } from "vitest";
import { buildMimeMessage, encodeSubject, toGmailRaw } from "../../src/google/mime.js";

function decodeBody(msg: string): string {
  const body = msg.split("\r\n\r\n")[1]!;
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
}
function decodeSubject(header: string): string {
  return [...header.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
    .map((m) => Buffer.from(m[1]!, "base64").toString("utf8"))
    .join("");
}

const base = {
  to: ["a@example.com"],
  subject: "Hello",
  body: "Hi there",
  bodyType: "text" as const,
};

describe("buildMimeMessage", () => {
  it("builds a plain-text message with CRLF and base64 body", () => {
    const msg = buildMimeMessage(base);
    expect(msg).toContain("To: a@example.com\r\n");
    expect(msg).toContain("Subject: Hello\r\n");
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(msg).toContain("Content-Transfer-Encoding: base64");
    expect(msg).not.toMatch(/(^|[^\r])\n/);
    expect(decodeBody(msg)).toBe("Hi there".replace(/\n/g, "\r\n"));
  });
  it("includes optional headers only when set", () => {
    const plain = buildMimeMessage(base);
    expect(plain).not.toMatch(/^(Cc|Bcc|Reply-To):/m);
    const full = buildMimeMessage({
      ...base,
      to: ["a@x.com", "b@x.com"],
      cc: ["c@x.com"],
      bcc: ["d@x.com"],
      replyTo: "e@x.com",
    });
    expect(full).toContain("To: a@x.com, b@x.com\r\n");
    expect(full).toContain("Cc: c@x.com\r\n");
    expect(full).toContain("Bcc: d@x.com\r\n");
    expect(full).toContain("Reply-To: e@x.com\r\n");
    expect(buildMimeMessage({ ...base, cc: [], bcc: [] })).not.toMatch(/^(Cc|Bcc):/m);
  });
  it("uses text/html when asked", () => {
    expect(buildMimeMessage({ ...base, bodyType: "html" })).toContain(
      'Content-Type: text/html; charset="UTF-8"',
    );
  });
  it("round-trips non-ASCII bodies and normalises line endings", () => {
    const body = "नमस्ते 🌍\nline two\r\nline three";
    expect(decodeBody(buildMimeMessage({ ...base, body }))).toBe(
      "नमस्ते 🌍\r\nline two\r\nline three",
    );
  });
  it("wraps base64 at 76 characters", () => {
    const msg = buildMimeMessage({ ...base, body: "x".repeat(500) });
    const lines = msg.split("\r\n\r\n")[1]!.trimEnd().split("\r\n");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(76);
  });
  it("does not let body text become headers", () => {
    const msg = buildMimeMessage({ ...base, body: "x\r\nBcc: evil@x.com" });
    expect(msg).not.toMatch(/^Bcc:/m);
  });
});

describe("encodeSubject", () => {
  it("leaves printable ASCII alone", () =>
    expect(encodeSubject("Meeting follow-up")).toBe("Meeting follow-up"));
  it.each([
    "Café ☕ meeting",
    "नमस्ते दुनिया",
    "会議のフォローアップ",
    "😀".repeat(40),
    "é".repeat(200),
  ])("encodes %s reversibly in <=75-char words", (s) => {
    const enc = encodeSubject(s);
    expect(decodeSubject(enc)).toBe(s);
    for (const word of enc.split("\r\n ")) expect(word.length).toBeLessThanOrEqual(75);
  });
});

describe("toGmailRaw", () => {
  it("is base64url without padding", () => {
    const raw = toGmailRaw("subject: ??>>>\r\nÿþ");
    expect(raw).not.toMatch(/[+/=]/);
    expect(Buffer.from(raw, "base64url").toString("utf8")).toBe("subject: ??>>>\r\nÿþ");
  });
});
