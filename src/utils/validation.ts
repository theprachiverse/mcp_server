import { AppError } from "./errors.js";

const EMAIL_MAX = 254;
const FORBIDDEN_ADDRESS_CHARS = /[\r\n,;<>\s"'()[\]\\]/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const LOCAL_PART = /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+$/;

export function isValidEmail(value: string): boolean {
  if (value.length === 0 || value.length > EMAIL_MAX) return false;
  if (FORBIDDEN_ADDRESS_CHARS.test(value)) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || local.length > 64) return false;
  if (
    !LOCAL_PART.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  ) {
    return false;
  }
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => DOMAIN_LABEL.test(l))) return false;
  return /[A-Za-z]/.test(labels[labels.length - 1]!);
}

function invalid(message: string): never {
  throw new AppError("INVALID_ARGUMENT", message);
}

/** Normalises string | string[] | undefined to a validated, trimmed address list. */
export function toAddressList(value: string | string[] | undefined, field: string): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((raw) => {
    const addr = raw.trim();
    if (addr === "") invalid(`'${field}' contains an empty address.`);
    if (!isValidEmail(addr)) {
      invalid(
        `'${field}' contains an invalid email address. Use plain addresses like name@example.com (no display names).`,
      );
    }
    return addr;
  });
}

export function hasDuplicateRecipients(...lists: string[][]): boolean {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const a of list) {
      const k = a.toLowerCase();
      if (seen.has(k)) return true;
      seen.add(k);
    }
  }
  return false;
}

export function assertSingleLine(value: string, field: string): void {
  if (/[\r\n]/.test(value)) invalid(`'${field}' must be a single line (no line breaks).`);
}

export function assertNotBlank(value: string, field: string): void {
  if (value.trim() === "") invalid(`'${field}' must not be empty or whitespace only.`);
}

/** Rejects control characters other than tab, CR and LF. */
export function assertNoControlChars(value: string, field: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    invalid(`'${field}' contains unsupported control characters.`);
  }
}

export function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

const DOC_ID = /^[A-Za-z0-9_-]{25,128}$/;
export const isValidDocId = (s: string): boolean => DOC_ID.test(s);

const NOT_DOC_PATHS: Record<string, string> = {
  spreadsheets: "Google Sheets",
  presentation: "Google Slides",
  forms: "Google Forms",
  drawings: "Google Drawings",
};

/** Extracts a document ID from a docs.google.com URL, or throws INVALID_ARGUMENT. */
export function parseDocsUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return invalid("'document_url' is not a valid URL.");
  }
  if (url.protocol !== "https:") invalid("'document_url' must use https.");
  if (url.username || url.password) invalid("'document_url' must not contain credentials.");
  if (url.port) invalid("'document_url' must not specify a port.");
  if (url.hostname !== "docs.google.com") invalid("'document_url' must be on docs.google.com.");
  const segs = url.pathname.split("/").filter(Boolean);
  const kind = segs[0];
  if (kind && kind in NOT_DOC_PATHS) {
    invalid(`This is a ${NOT_DOC_PATHS[kind]} link. Only Google Docs are supported.`);
  }
  let rest = segs;
  if (rest[0] === "document" && rest[1] === "u" && /^\d+$/.test(rest[2] ?? "")) {
    rest = ["document", ...rest.slice(3)];
  }
  if (rest[0] !== "document" || rest[1] !== "d" || !rest[2]) {
    invalid("'document_url' is not a Google Docs document link (expected /document/d/<id>).");
  }
  const id = rest[2];
  if (!isValidDocId(id)) invalid("'document_url' contains an invalid document ID.");
  return id;
}

export function resolveDocumentId(args: {
  document_id?: string | undefined;
  document_url?: string | undefined;
}): string {
  const hasId = args.document_id !== undefined && args.document_id.trim() !== "";
  const hasUrl = args.document_url !== undefined && args.document_url.trim() !== "";
  if (hasId === hasUrl) invalid("Provide exactly one of 'document_id' or 'document_url'.");
  if (hasId) {
    const id = args.document_id!.trim();
    if (!isValidDocId(id)) invalid("'document_id' is not a valid Google Docs document ID.");
    return id;
  }
  return parseDocsUrl(args.document_url!);
}

export const docUrlFromId = (id: string): string => `https://docs.google.com/document/d/${id}/edit`;
