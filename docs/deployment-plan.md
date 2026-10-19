# Deployment plan: Google Workspace MCP server on Railway

Status: code (Phase 1) and Railway config (Phase 2) are implemented. Phases 3-4 (Google setup, deploy) are manual steps for you. Where the implementation differs from the first draft of this plan, the notes in §5 say so.

## 1. Read this first: the server cannot be deployed as it is

Railway runs web services. A service must listen on an HTTP port, and clients reach it over a public
HTTPS URL. This server does neither today:

| Today (V1) | What Railway needs |
|---|---|
| Transport is **stdio** (`src/index.ts` uses `StdioServerTransport`). It exits when stdin closes. | An HTTP server on `$PORT` that stays running (MCP **Streamable HTTP**). |
| No client authentication. Whoever can run the process can send mail as the account. | Authentication on every request, because the URL will be public and the tools send real email. |
| Google consent is a **loopback** flow (`npm run auth` opens a browser on `127.0.0.1`). | The consent step cannot run on Railway. It stays on your laptop and the resulting token is moved to Railway. |
| Token is a file in `./.local/` (git-ignored, absent from a deploy). | The token must reach the container through a secret variable (optionally a volume). |

The README says the server "must not be exposed publicly as-is", and `architecture.md` §16 already sketches
the remote option. This plan implements the **smallest safe version** of that sketch:

- single user, i.e. one Google account, the one you authorise;
- one static bearer token protects the endpoint;
- tool, service, validation and MIME code are untouched.

Per-user Google OAuth and OAuth 2.1 for MCP clients (needed for claude.ai / ChatGPT connectors) are
out of scope and listed in §11.

## 2. Target architecture

```
 MCP client (Claude Code, Cursor, Inspector, custom agent)
        |  HTTPS  POST /mcp   Authorization: Bearer <MCP_AUTH_TOKEN>
        v
 Railway edge (TLS, <name>.up.railway.app)
        |
        v
 Container: node dist/http.js  (listens on 0.0.0.0:$PORT)
   - /healthz            no auth, no secrets, used by Railway healthchecks
   - /mcp                bearer auth -> rate limit -> Streamable HTTP (stateless)
   - tools                gmail_send_email, google_docs_append_text (unchanged)
   - token                GOOGLE_TOKEN_B64 -> written to the token file at boot
        |
        v
 Google APIs (Gmail send, Docs)
```

## 3. Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | MCP transport | Streamable HTTP, **stateless** (new `McpServer` + transport per POST) | The tools are request/response with no server push, and stateless works with restarts and redeploys. `@modelcontextprotocol/sdk` 1.32.1 already ships `streamableHttp.js`. |
| D2 | Client auth | Static bearer token (`MCP_AUTH_TOKEN`, at least 32 random bytes), compared in constant time | Smallest thing that keeps strangers from sending mail as you. Works with Claude Code, Cursor, MCP Inspector and custom clients. **Does not** work with claude.ai or ChatGPT connectors (see §11). |
| D3 | Google token delivery | Base64 of `google-token.json` in secret variable `GOOGLE_TOKEN_B64`, written to the token file at startup if the file is missing | No volume needed. The refresh token does not change, and the server refreshes access tokens itself. A volume is optional (see D4). |
| D4 | Persistent volume | **Not used** in V1 | Without it, access tokens are re-fetched after each redeploy, which is harmless. Add a volume only if Google starts rotating refresh tokens (watch for `auth.token_persist_failed` and unexpected `AUTH_EXPIRED`). |
| D5 | Replicas | Exactly 1 | Single-user server with a local token file; there is nothing to gain from more. |
| D6 | Build | Railway's default builder (Railpack) with `railway.json` | Config-as-code lives in the repo and can be reviewed. |
| D7 | Google consent screen | Move from **Testing** to **In production** | In Testing, Google expires refresh tokens after **7 days**, so a deployed server would break weekly. See §8. |

## 4. Prerequisites

- [ ] GitHub repo is reachable by Railway: `https://github.com/theprachiverse/mcp_server` (remote `origin`).
- [ ] Railway account, with a plan that allows an always-on service (check current plan limits and pricing at railway.com).
- [ ] Google Cloud project with the Gmail API and Docs API enabled and a working **Desktop app** OAuth client (already used for local `npm run auth`).
- [ ] `npm run check` is green locally.
- [ ] Working tree is clean enough to commit: `git status` currently shows the three docs moved into `docs/` as deleted + untracked. Stage that move first (`git add -A docs architecture.md implementation-plan.md problemStatement.md`).
- [ ] Confirm `.env`, `.local/` and `dist/` are git-ignored (they are in `.gitignore`). Never run `railway up` from a folder where that is not true.

## 5. Phase 1: code changes (implemented)

Implementation notes (differences from the original draft):
- `/healthz` is registered **before** the Host-header check, so Railway's health checker works whatever Host it sends. `healthcheck.railway.app` therefore no longer needs to be in `MCP_ALLOWED_HOSTS`.
- Railway's `RAILWAY_PUBLIC_DOMAIN` is added to the allowed hosts automatically; `MCP_ALLOWED_HOSTS` is only needed for custom domains. `localhost`, `127.0.0.1` and `[::1]` are always allowed so local runs work.
- The rate limiter runs **before** bearer auth (so floods of bad tokens are throttled too), and the body is parsed only after auth succeeds.
- `MCP_TRUST_PROXY` defaults to 1 on Railway (so the limiter sees client IPs, not the proxy) and 0 elsewhere. New optional variables: `MCP_RATE_LIMIT_PER_MINUTE` (default 30) and `MCP_TRUST_PROXY`.
- Replies use JSON (`enableJsonResponse`), not SSE.
- Files: `src/http.ts`, `src/http/app.ts`, `src/http/bearer-auth.ts`, `src/bootstrap.ts`, `seedTokenStore` in `src/auth/token-store.ts`, `railway.json`, tests `http-server.test.ts` and `token-seed.test.ts`.


### 5.1 `src/http.ts`: new entry point (stdio entry stays as it is)

Responsibilities:

1. Load `.env` (local only) and config, exactly like `index.ts`.
2. **Fail fast** if `MCP_AUTH_TOKEN` is missing or shorter than 32 characters.
3. Seed the token file from `GOOGLE_TOKEN_B64` when the file does not exist (§5.3).
4. Build the same services and tools as `index.ts`. Move this wiring into a shared `src/bootstrap.ts` so both entry points use one copy.
5. Start Express on `0.0.0.0:${PORT}` with:
   - `GET /healthz` returning `200 {"status":"ok"}`. It must not touch Google or reveal config.
   - `POST /mcp` behind `bearerAuth` and a rate limiter, handled statelessly:

     ```ts
     app.post("/mcp", bearerAuth, limiter, async (req, res) => {
       const server = createServer({ tools, logger, version });
       const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
       res.on("close", () => { void transport.close(); void server.close(); });
       await server.connect(transport);
       await transport.handleRequest(req, res, req.body);
     });
     // Stateless mode has no SSE stream or sessions to manage.
     app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").end());
     app.delete("/mcp", (_req, res) => res.status(405).set("Allow", "POST").end());
     ```

   - JSON body limit of 2 MB. The email body limit is 1 MiB, plus JSON overhead.
6. Host-header protection against DNS rebinding: use `createMcpExpressApp({ host: "0.0.0.0", allowedHosts })`,
   where `allowedHosts` comes from `MCP_ALLOWED_HOSTS` (the Railway domain). **Also allow
   `healthcheck.railway.app`**, the Host header Railway's healthchecker sends, or deploys will fail.
7. Graceful shutdown on `SIGTERM` (Railway sends it on redeploy): stop accepting connections, wait up to about 10 s, exit 0.
8. Keep the existing `unhandledRejection` / `uncaughtException` handlers.

### 5.2 `src/http/bearer-auth.ts`: authentication middleware

- Read `Authorization: Bearer <token>`.
- Compare SHA-256 digests of both values with `crypto.timingSafeEqual`, so length differences leak nothing.
- On failure return `401` with `WWW-Authenticate: Bearer` and a generic body. Log only `auth.rejected` with the request ID and IP. **Never log the header or the supplied token** (the existing logger already redacts `authorization`).

### 5.3 Token seeding (`src/auth/token-store.ts` or a helper in `bootstrap.ts`)

```ts
// If GOOGLE_TOKEN_B64 is set and the token file does not exist, decode it and store.write() it.
// Validate with the existing tokenSchema. On bad input, exit with a clear message that does not echo the value.
```

Set `GOOGLE_TOKEN_PATH=/tmp/google-token.json` on Railway so the write goes to a writable path outside the app directory.

### 5.4 `package.json` and config

- Add a script: `"start:http": "node dist/http.js"`. Keep `"start"` as the stdio entry.
- Add `express` (^5) and `express-rate-limit` as **direct** dependencies. They are only transitive through the SDK today, and relying on that is fragile. Keep versions compatible with the SDK's ranges.
- Extend the zod schema in `src/config.ts` with `PORT` (default 3000), `MCP_AUTH_TOKEN`, `MCP_ALLOWED_HOSTS` and `GOOGLE_TOKEN_B64`, all **optional for stdio** and enforced in `http.ts`. Stdio users must not be forced to set them.

### 5.5 Tests (all offline, in `tests/unit`)

- `http-auth.test.ts`: missing, wrong and correct token give 401, 401, 200; the token never appears in logs.
- `http-server.test.ts`: `initialize` then `tools/list` returns exactly the two tools; `GET /mcp` returns 405; `/healthz` returns 200 without auth.
- `token-seed.test.ts`: seeds when the file is missing; leaves an existing file untouched; rejects invalid base64/JSON without echoing it.
- `npm run check` must stay green, and the existing `stdio-process.test.ts` must still pass (proves stdio is unaffected).

## 6. Phase 2: Railway config files

### 6.1 `railway.json` (repo root)

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "RAILPACK",
    "buildCommand": "npm run build"
  },
  "deploy": {
    "startCommand": "npm run start:http",
    "healthcheckPath": "/healthz",
    "healthcheckTimeout": 60,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5,
    "numReplicas": 1
  }
}
```

Notes:
- Railway installs devDependencies during the build, so `tsc` is available for `npm run build`.
- `package.json` requires Node `>=22.9`. If the build log shows an older Node, set `RAILPACK_NODE_VERSION=22` as a service variable.
- Confirm the field names against the current Railway config-as-code docs when you create the file; the schema URL gives editor validation.

### 6.2 What gets uploaded

Railway CLI uploads respect `.gitignore`. Deploying from GitHub is preferred (§8) because it uploads nothing from your machine.

## 7. Phase 3: Google Cloud changes

1. **OAuth consent screen**: change Publishing status from **Testing** to **In production** (for personal use). Because `gmail.send` and `documents` are sensitive scopes, Google will show the "unverified app" warning during consent. Choose *Advanced → Continue* on your own account. Apps left in Testing get 7-day refresh tokens, which is the main operational risk of this deployment.
   - Verify this in the Cloud Console after switching: authorise again and check that the app no longer lists a 7-day limit. Unverified production apps are capped at 100 users, which is irrelevant for a single user.
2. **Re-run consent locally** after the switch so the new token is not a Testing-mode token:
   ```powershell
   npm run build
   npm run auth -- --revoke
   npm run auth
   npm run auth -- --status     # confirm account and scopes
   ```
3. **Encode the token for Railway** (PowerShell; the output is a secret, so do not paste it into chats or tickets):
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes(".\.local\google-token.json")) | Set-Clipboard
   ```
4. **No change to the OAuth client or redirect URIs.** Consent still happens locally, so the Desktop client's loopback flow keeps working. Railway only ever uses the refresh token.

## 8. Phase 4: deploy

### 8.1 Create the project (dashboard route, recommended)

1. Railway → **New Project → Deploy from GitHub repo** → pick `theprachiverse/mcp_server`, branch `main`.
2. Open the service → **Variables** and add the values in §9. Use the clipboard value from §7 step 3 for `GOOGLE_TOKEN_B64`.
3. **Settings → Networking → Generate Domain** to get `https://<name>.up.railway.app`. Redeploy once so `RAILWAY_PUBLIC_DOMAIN` is available to the server (add `MCP_ALLOWED_HOSTS` only for a custom domain).
4. Confirm **Settings → Deploy → Replicas = 1** and that the healthcheck path shows `/healthz` (from `railway.json`).
5. Optional: **Settings → Deploy → Wait for CI** so only green commits deploy (add a GitHub Action that runs `npm run check`).

### 8.2 CLI route (alternative)

```powershell
npm i -g @railway/cli
railway login
railway init                      # or: railway link
railway variables --set "MCP_AUTH_TOKEN=..." --set "GOOGLE_OAUTH_CLIENT_ID=..." ...   # see §9
railway up                        # uploads the folder, honouring .gitignore
railway domain
```

Prefer the dashboard for secrets: command-line values end up in shell history.

## 9. Environment variables (Railway service)

| Variable | Required | Value / notes |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | yes | From the Desktop OAuth client. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes | Mark as secret; never log it. |
| `GOOGLE_TOKEN_B64` | yes | Base64 of `.local/google-token.json` (§7). Used only to seed the token file. |
| `GOOGLE_TOKEN_PATH` | yes | `/tmp/google-token.json` |
| `MCP_AUTH_TOKEN` | yes | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`; at least 32 characters. Different from every Google secret. |
| `MCP_ALLOWED_HOSTS` | no | Only for custom domains. Railway's own domain is added automatically. |
| `MCP_RATE_LIMIT_PER_MINUTE` | no | Default 30 per client IP. |
| `MCP_TRUST_PROXY` | no | Default 1 on Railway. |
| `PORT` | no | Set by Railway automatically. Do not hard-code it. |
| `NODE_ENV` | no | `production` |
| `LOG_LEVEL` | no | `info` (default). Use `debug` only briefly. |
| `GMAIL_MAX_*`, `DOCS_*`, `GOOGLE_API_TIMEOUT_MS`, `DOCS_TIMESTAMP_TIMEZONE` | no | Defaults from `.env.example` apply. |
| `GOOGLE_OAUTH_REDIRECT_PORT` | no | Unused on the server (consent is local). |

Never set `RUN_INTEGRATION_TESTS` or any `INTEGRATION_*` variable in Railway.

## 10. Verification

Run these in order after the first successful deploy. Replace `$URL` and `$TOKEN`.

1. **Health**: `curl.exe -i $URL/healthz` returns `200`.
2. **Auth is enforced**:
   - `curl.exe -i -X POST $URL/mcp` returns `401`.
   - Same request with a wrong token returns `401`.
3. **Discovery** (correct token). Streamable HTTP requires both `Accept` types:
   ```powershell
   curl.exe -s -X POST "$URL/mcp" `
     -H "Authorization: Bearer $TOKEN" `
     -H "Content-Type: application/json" `
     -H "Accept: application/json, text/event-stream" `
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```
   Expect exactly `gmail_send_email` and `google_docs_append_text`. If the server rejects `tools/list` before `initialize`, send `initialize` first or use the Inspector.
4. **MCP Inspector**: `npx @modelcontextprotocol/inspector` → transport *Streamable HTTP*, URL `$URL/mcp`, header `Authorization: Bearer <token>`. List tools and call each one.
5. **Real client** (Claude Code):
   ```
   claude mcp add --transport http google-workspace https://<name>.up.railway.app/mcp --header "Authorization: Bearer <token>"
   ```
6. **Functional smoke test** with a throw-away Doc and a mailbox you control: append one line to the test doc, then send one email to yourself. Re-use the relevant items from `docs/manual-test-checklist.md`.
7. **Logs** (Railway → Deployments → Logs): you should see `server.started` and `tool.call` lines with outcomes and request IDs, and **no** recipients, subjects, bodies, document text, tokens or full document IDs.
8. **Restart test**: redeploy once, then repeat step 6. It must still work without re-authorising.

Do not run the destructive or large-recipient tests against production data.

## 11. Known limits of this plan

- **Hosted connectors are not supported.** claude.ai custom connectors and ChatGPT connectors expect an OAuth-capable MCP server, not a static bearer token. Supporting them needs the MCP authorization flow (OAuth 2.1 with discovery and dynamic client registration, e.g. via the SDK's `server/auth` helpers) in front of `/mcp`. That is a separate, larger piece of work.
- **Single user, single Google account.** Everyone holding `MCP_AUTH_TOKEN` can send mail as that account and edit any Doc it can edit. Treat the token like a password.
- **Re-authorisation is manual.** If Google revokes the token (password change, access removed, long inactivity) tools return `AUTH_EXPIRED`. Fix: §12.
- **Email sends cannot be undone**, and `OPERATION_OUTCOME_UNKNOWN` can still occur over the network. A client retry loop in front of this server could double-send. The server does not de-duplicate across requests.
- Railway specifics (builder name, config field names, healthcheck host, plan limits) change over time. Re-check them against Railway's current docs while implementing.

## 12. Operations

| Task | Procedure |
|---|---|
| **Re-authorise Google** (`AUTH_EXPIRED`) | Locally: `npm run auth`, re-encode (§7 step 3), update `GOOGLE_TOKEN_B64` in Railway, then **redeploy**. A redeploy starts a fresh container with no token file, so the new value is seeded. A plain restart is not enough, because the old file may still exist. |
| **Rotate `MCP_AUTH_TOKEN`** | Generate a new value, update Railway and every client config, redeploy. Do this immediately if it may have leaked, and on a schedule (for example every 90 days). |
| **Rotate Google client secret** | Create a new secret in Cloud Console, update `GOOGLE_OAUTH_CLIENT_SECRET`, redeploy, then delete the old secret. |
| **Emergency stop** | Railway → service → **Remove/Stop** (or delete the domain). Then `npm run auth -- --revoke` locally, or remove access at <https://myaccount.google.com/permissions>. |
| **Roll back** | Railway → Deployments → pick a previous successful deploy → **Redeploy**. |
| **Update** | Merge to `main`; Railway auto-deploys (with "Wait for CI" if enabled). Healthcheck failure keeps the old deploy running. |
| **Monitor** | Railway logs and deployment status; add an external uptime check on `/healthz`. Optionally set a Railway usage limit alert. |

## 13. Security checklist (go-live gate)

- [ ] `MCP_AUTH_TOKEN` is at least 32 random bytes and stored only in Railway and the client config.
- [ ] `/mcp` returns 401 without the token (verified from outside, over the public URL).
- [ ] Only HTTPS is used by clients. Railway terminates TLS; clients must not use `http://`.
- [ ] A request with a foreign `Host` header is refused with 403 (allowed hosts are the Railway domain plus any custom domain).
- [ ] Rate limit is active on `/mcp` (suggested: 30 requests/min per IP) and returns 429 when exceeded.
- [ ] No secret appears in git history, Railway build logs or runtime logs. Search the logs for `ya29.`, `GOCSPX-` and `1//`.
- [ ] Google scopes are still only `gmail.send`, `documents`, `openid`, `email` (`npm run auth -- --status`).
- [ ] The `.env` and `.local/` files were never committed (`git log --all -- .env .local` is empty).
- [ ] Dedicated Google account used for first deploy, not a primary mailbox.
- [ ] Railway project access is limited to people who may send mail as that account.

## 14. Documentation updates to make alongside the code

- `README.md` §6 "Local stdio vs. remote hosting" and §12: replace "must not be exposed publicly" with the Railway setup and its limits (single user, bearer token).
- `README.md` §5 commands table: add `npm run start:http`.
- `.env.example`: add `PORT`, `MCP_AUTH_TOKEN`, `MCP_ALLOWED_HOSTS`, `GOOGLE_TOKEN_B64` (commented, with notes).
- `docs/architecture.md` §16: record that a minimal single-user HTTP mode now exists and what remains future work.
- `docs/manual-test-checklist.md`: add a "Remote (Railway)" section from §10.

## 15. Work breakdown and order

| Step | Task | Output |
|---|---|---|
| 1 | Stage the docs move and commit it | Clean tree |
| 2 | Extract `bootstrap.ts`; add `http.ts`, `bearer-auth.ts`, token seeding, config fields | Code |
| 3 | Add tests (§5.5); `npm run check` green; also run locally with `PORT=3000` and curl | Tests passing |
| 4 | Add `railway.json`, `start:http`, docs updates | Config + docs |
| 5 | Google: move to In production, re-consent, encode token (§7) | `GOOGLE_TOKEN_B64` |
| 6 | Create the Railway project, set variables, generate domain, set `MCP_ALLOWED_HOSTS` (§8, §9) | Live URL |
| 7 | Verify (§10) and clear the go-live gate (§13) | Sign-off |
| 8 | Connect your real client, then record the tested client in README §9 | Done |

## 16. Open questions for you

1. **Which clients must connect?** If the answer includes claude.ai or ChatGPT connectors, the bearer-token design is not enough and §11 becomes part of the scope.
2. **Is Google "In production" (unverified, personal use) acceptable?** The alternative is keeping Testing mode and re-authorising every 7 days.
3. **Dedicated Google account or your main one** for the first deployment? A dedicated account is strongly recommended.
