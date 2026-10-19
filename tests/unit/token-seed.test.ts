import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { seedTokenStore, TokenSeedError, TokenStore } from "../../src/auth/token-store.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gwmcp-seed-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const b64 = (v: unknown) =>
  Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64");
const tokens = {
  refresh_token: "1//SEED-REFRESH-TOKEN",
  access_token: "ya29.seed",
  scope: "https://www.googleapis.com/auth/gmail.send",
};

describe("seedTokenStore", () => {
  it("writes the token file when none exists", () => {
    const store = new TokenStore(path.join(tmp, "a", "token.json"));
    expect(seedTokenStore(store, b64(tokens))).toBe("seeded");
    expect(store.read()).toMatchObject({ refresh_token: tokens.refresh_token });
  });

  it("tolerates line breaks that a copied value may contain", () => {
    const store = new TokenStore(path.join(tmp, "wrapped", "token.json"));
    const wrapped = b64(tokens).replace(/(.{20})/g, "$1\r\n");
    expect(seedTokenStore(store, wrapped)).toBe("seeded");
    expect(store.read()?.refresh_token).toBe(tokens.refresh_token);
  });

  it("leaves an existing file untouched, because a refreshed file is newer than the variable", () => {
    const store = new TokenStore(path.join(tmp, "b", "token.json"));
    store.write({ refresh_token: "existing", access_token: "fresh" });
    expect(seedTokenStore(store, b64(tokens))).toBe("exists");
    expect(store.read()?.refresh_token).toBe("existing");
  });

  it.each([
    ["not JSON", "!!! not base64 json !!!"],
    ["JSON without a refresh_token", b64({ access_token: "ya29.only-access" })],
    ["a JSON array", b64([1, 2, 3])],
    ["an empty value", ""],
  ])("rejects %s without writing a file or echoing the value", (_label, value) => {
    const file = path.join(tmp, `bad-${Math.random().toString(36).slice(2)}`, "token.json");
    const store = new TokenStore(file);
    let error: unknown;
    try {
      seedTokenStore(store, value);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TokenSeedError);
    const message = (error as Error).message;
    expect(message).toMatch(/GOOGLE_TOKEN_B64/);
    if (value) expect(message).not.toContain(value);
    expect(message).not.toContain("ya29.only-access");
    expect(fs.existsSync(file)).toBe(false);
  });
});
