import http from "node:http";
import { randomBytes } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import type { Credentials } from "google-auth-library";
import type { Config } from "../config.js";
import { AppError } from "../utils/errors.js";
import type { Logger } from "../utils/logging.js";
import { TokenStore, type StoredTokens } from "./token-store.js";

export const SCOPE_GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
export const SCOPE_DOCS = "https://www.googleapis.com/auth/documents";

/** The ONLY place OAuth scopes are listed. `openid`/`email` only identify the account. */
export const SCOPES: readonly string[] = [SCOPE_GMAIL_SEND, SCOPE_DOCS, "openid", "email"];

export type Capability = "gmail" | "docs";
const CAPABILITY_SCOPE: Record<Capability, { scope: string; label: string }> = {
  gmail: { scope: SCOPE_GMAIL_SEND, label: "sending email" },
  docs: { scope: SCOPE_DOCS, label: "editing Google Docs" },
};

export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}/oauth2callback`;
}

export function createOAuthClient(
  config: Pick<Config, "clientId" | "clientSecret" | "redirectPort">,
) {
  return new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: redirectUri(config.redirectPort),
  });
}

/** Supplies an authorised OAuth client to the Google services. */
export interface AuthProvider {
  getClient(capability: Capability): Promise<OAuth2Client>;
}

export class GoogleAuthProvider implements AuthProvider {
  private readonly client: OAuth2Client;
  private loadedMtime: number | null = null;

  constructor(
    config: Pick<Config, "clientId" | "clientSecret" | "redirectPort">,
    private readonly store: TokenStore,
    private readonly logger: Logger,
    client?: OAuth2Client,
  ) {
    this.client = client ?? createOAuthClient(config);
    this.client.on("tokens", (fresh: Credentials) => this.persistRefreshed(fresh));
  }

  private persistRefreshed(fresh: Credentials): void {
    try {
      const current = this.store.read();
      if (!current && !fresh.refresh_token) return;
      const merged = {
        ...(current ?? {}),
        ...stripNulls(fresh),
        refresh_token: fresh.refresh_token ?? current?.refresh_token,
      } as StoredTokens;
      this.store.write(merged);
      this.loadedMtime = this.store.mtimeMs();
    } catch (err) {
      this.logger.warn("auth.token_persist_failed", { error: err });
    }
  }

  async getClient(capability: Capability): Promise<OAuth2Client> {
    const mtime = this.store.mtimeMs();
    if (mtime === null) throw new AppError("AUTH_REQUIRED");
    if (mtime !== this.loadedMtime) {
      const tokens = this.store.read();
      if (!tokens) throw new AppError("AUTH_REQUIRED");
      this.client.setCredentials(tokens as Credentials);
      this.loadedMtime = mtime;
    }
    const granted = (this.client.credentials.scope ?? "").split(/\s+/);
    const need = CAPABILITY_SCOPE[capability];
    if (!granted.includes(need.scope)) {
      throw new AppError(
        "AUTH_REQUIRED",
        `The saved Google authorization does not allow ${need.label}. Run \`npm run auth\` again and approve all requested access.`,
      );
    }
    try {
      // Refresh an expired token now, so auth problems never look like an ambiguous write.
      await this.client.getAccessToken();
    } catch (err) {
      throw mapRefreshError(err);
    }
    return this.client;
  }
}

function stripNulls(c: Credentials): Record<string, unknown> {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined));
}

function mapRefreshError(err: unknown): AppError {
  const e = err as { message?: string; code?: string; response?: { data?: { error?: string } } };
  if (e?.response?.data?.error === "invalid_grant" || /invalid_grant/.test(e?.message ?? "")) {
    return new AppError("AUTH_EXPIRED", undefined, { cause: err });
  }
  if (
    ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"].includes(e?.code ?? "")
  ) {
    return new AppError("NETWORK_ERROR", undefined, { cause: err, retryable: true });
  }
  return new AppError("AUTH_EXPIRED", undefined, { cause: err });
}

// ---------------------------------------------------------------- consent flow

export type CallbackResult = { code: string } | { error: string };

/** Validates the loopback callback URL. Pure, so it is unit-tested. */
export function parseCallback(requestUrl: string, expectedState: string): CallbackResult {
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (url.pathname !== "/oauth2callback") return { error: "Unexpected callback path." };
  const err = url.searchParams.get("error");
  if (err) {
    return {
      error:
        err === "access_denied"
          ? "Access was denied on the consent screen."
          : "Google returned an error.",
    };
  }
  if (url.searchParams.get("state") !== expectedState) {
    return { error: "State mismatch. The request may not have started from this tool." };
  }
  const code = url.searchParams.get("code");
  if (!code) return { error: "No authorization code was returned." };
  return { code };
}

export interface ConsentDeps {
  openBrowser: (url: string) => void;
  log: (message: string) => void;
  timeoutMs?: number;
}

export async function runConsentFlow(
  config: Pick<Config, "clientId" | "clientSecret" | "redirectPort">,
  store: TokenStore,
  deps: ConsentDeps,
): Promise<{ email?: string; scopes: string[] }> {
  const client = createOAuthClient(config);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(16).toString("hex");
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...SCOPES],
    code_challenge_method: CodeChallengeMethod.S256,
    ...(codeChallenge ? { code_challenge: codeChallenge } : {}),
    state,
  });

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "GET" || !req.url?.startsWith("/oauth2callback")) {
        res.writeHead(404).end();
        return;
      }
      const result = parseCallback(req.url, state);
      const ok = "code" in result;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(
        ok
          ? "Authorization complete. You can close this tab."
          : `Authorization failed: ${result.error}`,
      );
      clearTimeout(timer);
      server.close();
      if (ok) resolve(result.code);
      else reject(new Error(result.error));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for authorization (5 minutes)."));
    }, deps.timeoutMs ?? 300_000);
    server.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === "EADDRINUSE"
          ? new Error(
              `Port ${config.redirectPort} is in use. Set GOOGLE_OAUTH_REDIRECT_PORT to a free port.`,
            )
          : e,
      );
    });
    server.listen(config.redirectPort, "127.0.0.1", () => {
      deps.log("Opening your browser to authorize access. If it does not open, visit:");
      deps.log(authUrl);
      deps.openBrowser(authUrl);
    });
  });

  const { tokens } = await client.getToken({
    code,
    codeVerifier,
    redirect_uri: redirectUri(config.redirectPort),
  });
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Remove this app at https://myaccount.google.com/permissions and run the command again.",
    );
  }
  const scopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  for (const need of Object.values(CAPABILITY_SCOPE)) {
    if (!scopes.includes(need.scope)) {
      throw new Error(
        `Required access for ${need.label} was not granted. Run the command again and approve all access.`,
      );
    }
  }
  store.write(stripNulls(tokens) as StoredTokens);
  return { ...(await accountEmail(client, tokens)), scopes };
}

async function accountEmail(
  client: OAuth2Client,
  tokens: Credentials,
): Promise<{ email?: string }> {
  try {
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: client._clientId as string,
      });
      const email = ticket.getPayload()?.email;
      if (email) return { email };
    }
  } catch {
    /* best effort only */
  }
  return {};
}

export async function getStatus(
  config: Pick<Config, "clientId" | "clientSecret" | "redirectPort">,
  store: TokenStore,
): Promise<{ authorized: boolean; scopes: string[]; expiry?: string; email?: string }> {
  const tokens = store.read();
  if (!tokens) return { authorized: false, scopes: [] };
  const client = createOAuthClient(config);
  client.setCredentials(tokens as Credentials);
  let email: string | undefined;
  try {
    const info = await client.getTokenInfo((await client.getAccessToken()).token ?? "");
    email = info.email;
  } catch {
    /* offline or revoked: report what we know */
  }
  return {
    authorized: true,
    scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean),
    ...(tokens.expiry_date ? { expiry: new Date(tokens.expiry_date).toISOString() } : {}),
    ...(email ? { email } : {}),
  };
}

/** Revokes at Google (best effort) and always deletes the local file. */
export async function revoke(
  config: Pick<Config, "clientId" | "clientSecret" | "redirectPort">,
  store: TokenStore,
): Promise<{ revoked: boolean; deleted: boolean }> {
  const tokens = store.read();
  if (!tokens) return { revoked: false, deleted: false };
  let revoked = false;
  try {
    await createOAuthClient(config).revokeToken(tokens.refresh_token);
    revoked = true;
  } catch {
    /* continue: the local copy is removed regardless */
  }
  return { revoked, deleted: store.delete() };
}
