export interface MimeInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  body: string;
  bodyType: "text" | "html";
}

const CRLF = "\r\n";

function wrap76(s: string): string {
  return s.match(/.{1,76}/g)?.join(CRLF) ?? "";
}

/** RFC 2047 encoding for non-ASCII subjects. Splits on code point boundaries, <=75 chars per word. */
export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = "";
  const flush = () => {
    if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
    chunk = "";
  };
  for (const ch of subject) {
    // Encoded word = 12 chars of framing + base64(bytes). Keep the whole word <= 75 chars.
    const bytes = Buffer.byteLength(chunk + ch, "utf8");
    if (12 + Math.ceil(bytes / 3) * 4 > 75) flush();
    chunk += ch;
  }
  flush();
  return words.join(CRLF + " ");
}

/** Builds a single-part RFC 5322 message with a base64 body. */
export function buildMimeMessage(m: MimeInput): string {
  const headers: string[] = [`To: ${m.to.join(", ")}`];
  if (m.cc && m.cc.length > 0) headers.push(`Cc: ${m.cc.join(", ")}`);
  if (m.bcc && m.bcc.length > 0) headers.push(`Bcc: ${m.bcc.join(", ")}`);
  if (m.replyTo) headers.push(`Reply-To: ${m.replyTo}`);
  headers.push(`Subject: ${encodeSubject(m.subject)}`);
  headers.push("MIME-Version: 1.0");
  headers.push(
    `Content-Type: ${m.bodyType === "html" ? "text/html" : "text/plain"}; charset="UTF-8"`,
  );
  headers.push("Content-Transfer-Encoding: base64");

  const normalized = m.body.replace(/\r\n|\r|\n/g, CRLF);
  const encodedBody = wrap76(Buffer.from(normalized, "utf8").toString("base64"));
  return headers.join(CRLF) + CRLF + CRLF + encodedBody + CRLF;
}

/** base64url without padding, as required by Gmail's `raw` field. */
export function toGmailRaw(message: string): string {
  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
