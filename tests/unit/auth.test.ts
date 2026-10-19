import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { GoogleAuthProvider, parseCallback, SCOPES } from "../../src/auth/google-oauth.js";
import { TokenStore } from "../../src/auth/token-store.js";
import { nullLogger } from "../../src/utils/logging.js";

let dir: string;
let store: TokenStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gwmcp-"));
  store = new TokenStore(path.join(dir, "sub", "token.json"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const cfg = { clientId: "cid", clientSecret: "csecret", redirectPort: 53682 };
const BOTH =
  "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/documents openid email";

describe("SCOPES", () => {
  it("is exactly the approved, least-privilege list", () => {
    expect([...SCOPES]).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/documents",
      "openid",
      "email",
    ]);
  });
});

describe("TokenStore", () => {
  it("returns null when missing and round-trips tokens atomically", () => {
    expect(store.read()).toBeNull();
    expect(store.mtimeMs()).toBeNull();
    store.write({ refresh_token: "r", access_token: "a", scope: BOTH });
    expect(store.read()).toMatchObject({ refresh_token: "r", access_token: "a" });
    expect(fs.readdirSync(path.dirname(store.path)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
  });
  it("reports corrupt files as AUTH_REQUIRED", () => {
    fs.mkdirSync(path.dirname(store.path), { recursive: true });
    fs.writeFileSync(store.path, "{not json");
    expect(() => store.read()).toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }));
    fs.writeFileSync(store.path, JSON.stringify({ access_token: "only" }));
    expect(() => store.read()).toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }));
  });
  it("deletes", () => {
    store.write({ refresh_token: "r" });
    expect(store.delete()).toBe(true);
    expect(store.delete()).toBe(false);
  });
});

describe("parseCallback", () => {
  const s = "state123";
  it("accepts a good callback", () => {
    expect(parseCallback(`/oauth2callback?code=abc&state=${s}`, s)).toEqual({ code: "abc" });
  });
  it.each([
    [`/oauth2callback?code=abc&state=wrong`, /State mismatch/],
    [`/oauth2callback?error=access_denied&state=${s}`, /denied/],
    [`/oauth2callback?state=${s}`, /No authorization code/],
    [`/other?code=abc&state=${s}`, /Unexpected/],
  ])("rejects %s", (url, re) => {
    expect(parseCallback(url, s)).toEqual({ error: expect.stringMatching(re) });
  });
});

describe("GoogleAuthProvider", () => {
  function fakeClient(opts: { refresh?: () => Promise<{ token: string }> } = {}) {
    const client = new OAuth2Client({ clientId: "x", clientSecret: "y" });
    client.getAccessToken = (opts.refresh ?? (async () => ({ token: "fresh" }))) as never;
    return client;
  }

  it("throws AUTH_REQUIRED when there is no token file", async () => {
    const p = new GoogleAuthProvider(cfg, store, nullLogger, fakeClient());
    await expect(p.getClient("gmail")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("loads credentials and refreshes before returning", async () => {
    store.write({ refresh_token: "r", scope: BOTH });
    const refresh = vi.fn(async () => ({ token: "fresh" }));
    const p = new GoogleAuthProvider(cfg, store, nullLogger, fakeClient({ refresh }));
    const c = await p.getClient("docs");
    expect(c.credentials.refresh_token).toBe("r");
    expect(refresh).toHaveBeenCalled();
  });

  it("names the missing capability when a scope was not granted", async () => {
    store.write({ refresh_token: "r", scope: "https://www.googleapis.com/auth/documents" });
    const p = new GoogleAuthProvider(cfg, store, nullLogger, fakeClient());
    await expect(p.getClient("gmail")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringMatching(/sending email/),
    });
    await expect(p.getClient("docs")).resolves.toBeDefined();
  });

  it("asks for a new authorisation when a token predates the draft scope", async () => {
    store.write({
      refresh_token: "r",
      scope:
        "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/documents openid email",
    });
    const p = new GoogleAuthProvider(cfg, store, nullLogger, fakeClient());
    await expect(p.getClient("gmail_draft")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringMatching(/creating Gmail drafts.*npm run auth/),
    });
    await expect(p.getClient("gmail")).resolves.toBeDefined();
    await expect(p.getClient("docs")).resolves.toBeDefined();
  });

  it("maps invalid_grant to AUTH_EXPIRED and network failure to NETWORK_ERROR", async () => {
    store.write({ refresh_token: "r", scope: BOTH });
    const expired = new GoogleAuthProvider(
      cfg,
      store,
      nullLogger,
      fakeClient({
        refresh: async () => {
          throw Object.assign(new Error("invalid_grant"), {
            response: { data: { error: "invalid_grant" } },
          });
        },
      }),
    );
    await expect(expired.getClient("gmail")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    const offline = new GoogleAuthProvider(
      cfg,
      store,
      nullLogger,
      fakeClient({
        refresh: async () => {
          throw Object.assign(new Error("dns"), { code: "ENOTFOUND" });
        },
      }),
    );
    await expect(offline.getClient("gmail")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("keeps the stored refresh token when Google sends only a new access token", () => {
    store.write({ refresh_token: "keep-me", access_token: "old", scope: BOTH });
    const client = fakeClient();
    new GoogleAuthProvider(cfg, store, nullLogger, client);
    client.emit("tokens", { access_token: "new", expiry_date: 123 });
    expect(store.read()).toMatchObject({
      refresh_token: "keep-me",
      access_token: "new",
      expiry_date: 123,
    });
  });

  it("picks up a re-authorisation without restart", async () => {
    store.write({ refresh_token: "one", scope: BOTH });
    const p = new GoogleAuthProvider(cfg, store, nullLogger, fakeClient());
    expect((await p.getClient("gmail")).credentials.refresh_token).toBe("one");
    store.write({ refresh_token: "two", scope: BOTH });
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(store.path, future, future);
    expect((await p.getClient("gmail")).credentials.refresh_token).toBe("two");
  });
});
