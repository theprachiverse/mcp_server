import { describe, expect, it } from "vitest";
import {
  hasDuplicateRecipients,
  isValidEmail,
  parseDocsUrl,
  resolveDocumentId,
  toAddressList,
} from "../../src/utils/validation.js";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abc";

describe("isValidEmail", () => {
  it.each(["a@example.com", "first.last+tag@sub.example.co.uk", "x_y@exa-mple.org"])(
    "accepts %s",
    (e) => expect(isValidEmail(e)).toBe(true),
  );
  it.each([
    "",
    "plain",
    "a@b",
    "a@@b.com",
    "a b@c.com",
    "a@c.com,d@e.com",
    "a@c.com;d@e.com",
    "Ann <a@c.com>",
    "a@c.com\r\nBcc: evil@x.com",
    ".a@c.com",
    "a..b@c.com",
    "a@-c.com",
    "a@c.123",
    `${"a".repeat(250)}@c.com`,
  ])("rejects %j", (e) => expect(isValidEmail(e)).toBe(false));
});

describe("toAddressList", () => {
  it("accepts a string or array and trims", () => {
    expect(toAddressList(" a@b.com ", "to")).toEqual(["a@b.com"]);
    expect(toAddressList(["a@b.com", "c@d.org"], "to")).toEqual(["a@b.com", "c@d.org"]);
    expect(toAddressList(undefined, "cc")).toEqual([]);
  });
  it("rejects empty and malformed entries with INVALID_ARGUMENT", () => {
    expect(() => toAddressList([""], "to")).toThrow(/empty/);
    expect(() => toAddressList("nope", "to")).toThrow(/invalid email/);
  });
  it("detects duplicates case-insensitively across lists", () => {
    expect(hasDuplicateRecipients(["A@b.com"], ["c@d.com"], ["a@B.com"])).toBe(true);
    expect(hasDuplicateRecipients(["a@b.com"], ["c@d.com"])).toBe(false);
  });
});

describe("parseDocsUrl", () => {
  it.each([
    `https://docs.google.com/document/d/${ID}/edit`,
    `https://docs.google.com/document/d/${ID}/edit?tab=t.0`,
    `https://docs.google.com/document/d/${ID}`,
    `https://docs.google.com/document/d/${ID}/edit#heading=h.abc`,
    `https://docs.google.com/document/u/1/d/${ID}/edit`,
  ])("extracts the ID from %s", (u) => expect(parseDocsUrl(u)).toBe(ID));

  it.each([
    ["not a url", /not a valid URL/],
    [`http://docs.google.com/document/d/${ID}/edit`, /https/],
    [`https://docs.google.com.evil.com/document/d/${ID}/edit`, /docs\.google\.com/],
    [`https://docs-google.com/document/d/${ID}/edit`, /docs\.google\.com/],
    [`https://user@docs.google.com/document/d/${ID}/edit`, /credentials/],
    [`https://docs.google.com:8443/document/d/${ID}/edit`, /port/],
    [`https://drive.google.com/file/d/${ID}/view`, /docs\.google\.com/],
    [`https://docs.google.com/spreadsheets/d/${ID}/edit`, /Google Sheets/],
    [`https://docs.google.com/presentation/d/${ID}/edit`, /Google Slides/],
    [`https://docs.google.com/forms/d/${ID}/edit`, /Google Forms/],
    ["https://docs.google.com/document/", /not a Google Docs/],
    ["https://docs.google.com/document/d/short/edit", /invalid document ID/],
    ["javascript:alert(1)", /https/],
  ])("rejects %s", (u, re) => expect(() => parseDocsUrl(u)).toThrow(re));
});

describe("resolveDocumentId", () => {
  it("accepts exactly one of id/url", () => {
    expect(resolveDocumentId({ document_id: ID })).toBe(ID);
    expect(
      resolveDocumentId({ document_url: `https://docs.google.com/document/d/${ID}/edit` }),
    ).toBe(ID);
    expect(() => resolveDocumentId({})).toThrow(/exactly one/);
    expect(() =>
      resolveDocumentId({ document_id: ID, document_url: "https://docs.google.com/document/d/x" }),
    ).toThrow(/exactly one/);
    expect(() => resolveDocumentId({ document_id: "../etc" })).toThrow(/not a valid/);
  });
});
