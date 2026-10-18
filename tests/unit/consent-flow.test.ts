import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConsentFlow } from "../../src/auth/google-oauth.js";
import { TokenStore } from "../../src/auth/token-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on("error", reject);
  });
}

describe("runConsentFlow loopback listener", () => {
  it("builds a PKCE authorisation URL and rejects a callback with the wrong state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gwmcp-consent-"));
    dirs.push(dir);
    const store = new TokenStore(path.join(dir, "token.json"));
    const port = 53900 + Math.floor(Math.random() * 90);
    let authUrl = "";
    const flow = runConsentFlow(
      { clientId: "cid", clientSecret: "secret", redirectPort: port },
      store,
      {
        openBrowser: (u) => {
          authUrl = u;
        },
        log: () => {},
        timeoutMs: 10_000,
      },
    );
    const outcome = flow.then(
      () => "resolved",
      (e: Error) => e.message,
    );
    for (let i = 0; i < 100 && !authUrl; i++) await new Promise((r) => setTimeout(r, 20));

    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/oauth2callback`);
    expect(u.searchParams.get("scope")!.split(" ")).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/documents",
      "openid",
      "email",
    ]);

    // Other paths are not served.
    expect(await get(`http://127.0.0.1:${port}/elsewhere`)).toBe(404);
    // A forged callback is refused and nothing is saved.
    expect(await get(`http://127.0.0.1:${port}/oauth2callback?code=x&state=forged`)).toBe(400);
    expect(await outcome).toMatch(/State mismatch/);
    expect(store.read()).toBeNull();
  });

  it("explains a busy port", async () => {
    const blocker = http.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = (blocker.address() as { port: number }).port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gwmcp-consent-"));
    dirs.push(dir);
    await expect(
      runConsentFlow(
        { clientId: "c", clientSecret: "s", redirectPort: port },
        new TokenStore(path.join(dir, "t.json")),
        { openBrowser: () => {}, log: () => {} },
      ),
    ).rejects.toThrow(/GOOGLE_OAUTH_REDIRECT_PORT/);
    blocker.close();
  });
});
