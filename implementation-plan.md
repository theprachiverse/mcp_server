# Implementation Plan: Google Workspace MCP Server (Version 1)

This plan turns [problemStatement.md](problemStatement.md) (the requirements) and
[architecture.md](architecture.md) (the design) into ordered, checkable work. It says **what
to build, in what order, and how to prove each step is done**. For *why* a design choice was
made, follow the `arch §N` references. `PS §N` points to the problem statement.

---

## 0. How to use this plan

- Work through the phases in order. Phases marked "can run in parallel" may overlap.
- Each phase ends with **Exit criteria**. Do not start a dependent phase until they pass.
- After every phase, run `npm run check` (typecheck + lint + unit tests). It must be green.
- One phase = one git commit (or a small series), with a message naming the phase.
- Never mark a test as passed unless it was actually run (PS §16 step 12). Record blocked
  checks as **BLOCKED** with the reason.
- If implementation shows the design is wrong, update `architecture.md` in the same commit
  and note it in the final report.

### Starting state (checked 2026-10-18)

| Item | Found |
|---|---|
| Files in `C:\NextLeap\mcp_server` | `problemStatement.md`, `architecture.md` only |
| Git | Installed (2.55), but this folder is **not a git repository** yet |
| Node.js / npm | v26.7.0 / 11.19.0 (meets the `>=22.9` requirement below) |
| Google Cloud project / OAuth client | Unknown. Assume **not available** until confirmed |

---

## 1. Phase overview

```text
 P0 Setup & decisions
   │
 P1 Project scaffold
   │
 P2 Shared utilities ──────────────┐
   │                               │
 P3 Google error mapping      P4 OAuth + token store + auth CLI      (P3 ∥ P4)
   │                               │
   ├──────────────┬────────────────┘
 P5 Docs append   P6 Gmail send                                      (P5 ∥ P6)
   └──────┬───────┘
 P7 MCP server wiring + entry point
   │
 P8 Integration tests (needs Google credentials)
   │
 P9 MCP client verification
   │
 P10 Documentation ── P11 Security review ── P12 Final report
```

| Phase | Goal | Size | Needs Google credentials? |
|---|---|---|---|
| P0 | Repo, decisions confirmed | S | No |
| P1 | Buildable, lintable, testable empty project | S | No |
| P2 | Errors, config, logging, retry, validation | M | No |
| P3 | Google error → `AppError` mapping | S | No |
| P4 | Consent flow, token storage, `AuthProvider` | M | Only for the live check |
| P5 | `google_docs_append_text` end to end with fakes | L | No |
| P6 | `gmail_send_email` end to end with fakes | M | No |
| P7 | MCP server, stdio entry, crash isolation | M | No |
| P8 | Opt-in tests against a test account | M | **Yes** |
| P9 | Tested in Antigravity and other clients | S | **Yes** |
| P10 | README, `.env.example`, manual checklist | M | No |
| P11 | Security pass | S | No |
| P12 | Final report | S | No |

S = under half a day, M = about a day, L = 1–2 days, for one developer.

Phases P0–P7 and P10–P11 can be completed without Google credentials. With no credentials,
P8 and P9 are reported as **BLOCKED** and the complete OAuth setup path still ships (PS §17).

---

## 2. P0 — Setup and decision gate

**Tasks**
- [ ] `git init`, create `main`, first commit with the two existing docs.
- [ ] Confirm the decisions below with the project owner. If there is no answer, use the
      recommended option and list it in the final report as "assumed".

| # | Decision | Source | Recommended |
|---|---|---|---|
| D1 | Add `openid` + `email` scopes to show the active account | arch §15 #1 | Yes |
| D2 | Bare email addresses only (no display names) | arch §15 #2 | Yes |
| D3 | Reject duplicate recipients instead of merging | arch §15 #3 | Yes |
| D4 | `add_separator_newline=false` still starts a new paragraph | arch §15 #4 | Yes |
| D5 | Ship `heading` and `insert_timestamp` in V1 | arch §15 #5 | Yes |
| D6 | Multi-tab docs: append to the first tab | arch §15 #6 | Yes |
| D7 | `GOOGLE_OAUTH_REDIRECT_PORT` instead of `GOOGLE_OAUTH_REDIRECT_URI` | arch §15 #7 | Yes |
| D8 | Use the per-API packages `@googleapis/gmail` + `@googleapis/docs` instead of the full `googleapis` package | New | Yes. Same official client and API, much smaller install and faster start-up. If chosen, update arch §2 |
| D9 | Integration email check is "message ID returned + manual look at Sent folder" because `gmail.send` cannot read mail | New, see P8 | Yes. Adding a read scope just for tests would break least privilege |

- [ ] In parallel, ask the owner to start the Google Cloud setup (see P10 "Google Cloud
      setup") so credentials are ready by P8: project, Gmail API + Docs API enabled, consent
      screen in **Testing** mode with the test account added, **Desktop app** OAuth client.

**Exit criteria:** repository exists; every decision is marked confirmed or assumed.

---

## 3. P1 — Project scaffold

**Files**

| File | Contents |
|---|---|
| `package.json` | `"type": "module"`, `"engines": { "node": ">=22.9" }`, `bin` not needed, scripts below |
| `tsconfig.json` | `strict`, `module`/`moduleResolution: "NodeNext"`, `target: "ES2023"`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, includes `src` and `tests` |
| `tsconfig.build.json` | Extends the above, `rootDir: src`, `outDir: dist`, excludes tests |
| `eslint.config.js` | Flat config with `typescript-eslint` + the import rules below |
| `.prettierrc.json` | Project formatting |
| `vitest.config.ts` | Two projects: `unit` (`tests/unit/**`) and `integration` (`tests/integration/**`) |
| `.gitignore` | `node_modules/`, `dist/`, `coverage/`, `.env`, `.env.*` except `.env.example`, `.local/`, `*.token.json`, `credentials*.json`, `client_secret*.json` |
| `.env.example` | Placeholder version; finished in P10 |
| `src/index.ts` | Temporary stub so the build has an entry point |
| `tests/unit/smoke.test.ts` | One trivial test, deleted in P7 |

**Dependencies**

- Runtime: `@modelcontextprotocol/sdk`, `@googleapis/gmail`, `@googleapis/docs`
  (or `googleapis` if D8 is rejected), `google-auth-library`, `zod`.
- Dev: `typescript`, `@types/node`, `vitest`, `eslint`, `typescript-eslint`, `prettier`, `tsx`.
- **Check the `zod` major version the MCP SDK expects** (its `peerDependencies`) and install
  that one. A mismatch makes tool schemas fail at runtime.

**Scripts**

```json
{
  "build": "tsc -p tsconfig.build.json",
  "typecheck": "tsc --noEmit",
  "lint": "eslint .",
  "format": "prettier --write .",
  "test": "vitest run --project unit",
  "test:integration": "vitest run --project integration",
  "check": "npm run typecheck && npm run lint && npm test",
  "start": "node dist/index.js",
  "auth": "node dist/cli/auth.js",
  "dev:auth": "tsx src/cli/auth.ts"
}
```

`.env` is loaded by the code (P2), not by a `--env-file` flag, because MCP clients run
`node dist/index.js` directly.

**ESLint import rules** (enforce arch §4)

| Files | Banned |
|---|---|
| `src/**` except `src/server.ts`, `src/index.ts` | `@modelcontextprotocol/sdk` and subpaths |
| `src/**` except `src/google/**`, `src/auth/**` | `googleapis`, `@googleapis/*`, `google-auth-library` |
| `src/tools/**` | `node:http`, `node:https`, `node:net`, `node:child_process`, global `fetch` |
| `src/**` except `src/cli/**` | `no-console` (stdout is the MCP channel) |

**Exit criteria:** `npm ci && npm run build && npm run check` pass on a clean clone; a test
file that imports the MCP SDK from `src/tools/` fails lint (try it once, then delete it).

---

## 4. P2 — Shared utilities

All of these are pure or near-pure and fully unit-tested.

### 4.1 `src/utils/errors.ts`
- [ ] `ERROR_CODES` constant tuple with the 11 codes from PS FR-5; `type ErrorCode`.
- [ ] `class AppError extends Error { code; retryable; publicMessage; cause? }`.
- [ ] Default public message per code, each with a next step (for example
      `AUTH_REQUIRED` → "Google authorization is missing. Run `npm run auth`.").
- [ ] `toPublicError(err: unknown): { code, message, retryable }`. Anything that is not an
      `AppError` becomes `INTERNAL_ERROR` with a generic message. `cause` is never included.

### 4.2 `src/config.ts`
- [ ] `findProjectRoot()` from `import.meta.url` (walk up to the folder with `package.json`).
- [ ] `loadDotEnv(root)`: if `<root>/.env` exists, call `process.loadEnvFile()`. Existing
      environment variables win (the MCP client's `env` block must override `.env`).
- [ ] `loadConfig(env, root): Readonly<Config>` using a zod schema for every variable in
      arch §13: numbers coerced with min/max bounds, `GOOGLE_TOKEN_PATH` resolved against
      `root` if relative, `DOCS_TIMESTAMP_TIMEZONE` checked with `Intl.DateTimeFormat`.
- [ ] `ConfigError` whose message lists the bad variable **names** and the rule broken, never
      their values.

### 4.3 `src/utils/logging.ts`
- [ ] `createLogger({ level, stream = process.stderr })` → `debug/info/warn/error(event, fields)`,
      one JSON line each, with `ts` and `level`.
- [ ] `redact(value)`: deep copy that removes/masks per arch §12 (key rules + token patterns
      `ya29.`, `1//`, `GOCSPX-`, `Bearer `). Handles cycles and `Error` objects.
- [ ] `hashId(id)`: first 12 hex chars of SHA-256, for logging document IDs.

### 4.4 `src/utils/retry.ts`
- [ ] `withRetry(fn, { maxAttempts, baseMs, maxMs, isRetryable, sleep?, random? })`.
- [ ] Full jitter: `delay = random() * min(maxMs, baseMs * 2^attempt)`; a `Retry-After`
      header (seconds or HTTP date) sets a floor, capped at `maxMs`.
- [ ] `sleep` and `random` are injectable so tests run instantly and deterministically.

### 4.5 `src/utils/validation.ts`
- [ ] `isValidEmail(s)` and `toAddressList(value: string | string[] | undefined)` per arch §6.3
      (trim, reject empty, reject `\r \n , ; < >`, max 254 chars).
- [ ] `findDuplicateRecipients(to, cc, bcc)`, case-insensitive (D3).
- [ ] `assertSingleLine(s, field)` for subject and heading.
- [ ] `isValidDocId(s)` (`^[A-Za-z0-9_-]{25,128}$`).
- [ ] `parseDocsUrl(s)` per arch §6.4 using `new URL()`; returns the ID or a specific reason.
- [ ] `resolveDocumentId({ document_id, document_url })`: exactly one must be set.
- [ ] `utf8ByteLength(s)`, and `findDisallowedControlChars(s)` (allow `\n` and `\t` only; `\r\n`
      is normalised to `\n` before this check).

**Tests** (`tests/unit/utils/*.test.ts`)
- Email: valid forms (plus-addressing, subdomains, IDN as punycode), invalid forms (no `@`,
  two `@`, spaces, trailing dot, injection characters, 255+ chars).
- Doc URLs: `/edit`, `/edit?tab=t.0`, `/u/1/d/…`, `#heading` fragments → accepted;
  `http:`, `docs.google.com.evil.com`, `docs-google.com`, `user@docs.google.com`,
  `docs.google.com:8443`, `/spreadsheets/d/…`, `/presentation/d/…`, `drive.google.com/file/d/…`,
  `javascript:` → rejected with the right reason.
- Config: each missing/invalid variable; the error text never contains the secret value;
  relative token path resolves against the root, not the cwd.
- Logging: a realistic gaxios-style error with `Authorization: Bearer ya29…`, a refresh
  token and an email body is redacted completely.
- Retry: attempt count, delay bounds, `Retry-After` handling, non-retryable error stops at once.

**Exit criteria:** all of the above tests pass; `npm run check` green.

---

## 5. P3 — Google error mapping (can run in parallel with P4)

### `src/google/google-errors.ts`
- [ ] `extractGoogleErrorInfo(err)`: HTTP status, `reason`
      (`response.data.error.errors[0].reason`), `status` string (`response.data.error.status`),
      OAuth error (`response.data.error === "invalid_grant"`), Node error code (`err.code`).
- [ ] `wasNeverDelivered(err)`: `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, and errors thrown
      before a request was made.
- [ ] `isAmbiguousWriteFailure(err)`: timeouts (`ETIMEDOUT`, `ECONNABORTED`, abort), `ECONNRESET`,
      `EPIPE`, HTTP 5xx.
- [ ] `isRevisionMismatch(err)`: HTTP 400 whose message refers to the required revision.
      **The exact message is confirmed in P8** and kept in a fixture.
- [ ] `mapGoogleError(err, { kind: "read" | "write" })` → `AppError`, implementing every row
      of arch §10. On `kind: "write"` an ambiguous failure becomes
      `OPERATION_OUTCOME_UNKNOWN`; on `kind: "read"` it becomes `NETWORK_ERROR` or
      `GOOGLE_API_ERROR` with `retryable: true`.

**Tests:** `tests/fixtures/google-errors/*.json` holds error shapes for each row of arch §10.
One table-driven test covers every row for both `read` and `write`. One test asserts that the
resulting public message never contains text from the Google response body.

**Exit criteria:** every arch §10 row has a passing test case.

---

## 6. P4 — OAuth, token store and auth CLI (can run in parallel with P3)

### 6.1 `src/auth/token-store.ts`
- [ ] Zod schema for the file: `refresh_token` (required), `access_token`, `expiry_date`,
      `scope`, `token_type`.
- [ ] `read()` → tokens or `null` if missing; a corrupt file → `AUTH_REQUIRED` with
      "token file is unreadable, run `npm run auth`".
- [ ] `write(tokens)`: create the folder (`0700` on POSIX), write `<file>.tmp` with mode `0600`,
      then rename. On Windows, skip `chmod` (ACLs are inherited; documented in README).
- [ ] `delete()`, `mtimeMs()`.

### 6.2 `src/auth/google-oauth.ts`
- [ ] `SCOPES` constant: `gmail.send`, `documents` (+ `openid`, `email` if D1). This is the
      **only** place scopes are listed.
- [ ] `createOAuthClient(config)` → `OAuth2Client` with client ID/secret and the loopback
      redirect URI built from `GOOGLE_OAUTH_REDIRECT_PORT`.
- [ ] `class AuthProvider` with `getClient(): Promise<OAuth2Client>`:
  1. `stat` the token file; reload credentials when `mtimeMs` changed (so re-auth works
     without restarting the client; avoid `fs.watch`, which is unreliable on Windows).
  2. No file → `AUTH_REQUIRED`.
  3. Granted `scope` missing a required scope → `AUTH_REQUIRED` naming the capability
     ("sending email" / "editing Google Docs").
  4. Call `client.getAccessToken()` so an expired token is refreshed **before** any write.
     `invalid_grant` → `AUTH_EXPIRED`; network failure → `NETWORK_ERROR`.
  5. A `tokens` event listener merges new tokens with the stored refresh token and saves them.
- [ ] `runConsentFlow(config, { openBrowser, log })`:
  - PKCE verifier/challenge via `generateCodeVerifierAsync()`, random `state`.
  - `generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES,
    code_challenge_method: "S256", code_challenge, state })`.
  - `http.createServer` bound to `127.0.0.1` on the configured port. Only
    `GET /oauth2callback` is handled; anything else gets 404. Port in use → clear error
    telling the user to set `GOOGLE_OAUTH_REDIRECT_PORT`.
  - 5-minute timeout; listener always closed in `finally`.
  - The callback logic lives in a pure `parseCallback(url, expectedState)` that rejects a
    wrong `state`, an `error=` parameter (for example `access_denied`) and a missing `code`.
  - `getToken({ code, codeVerifier, redirect_uri })`; refuse to save if no refresh token was
    returned.
- [ ] `getStatus()` → account email (via `getTokenInfo`, needs D1), granted scopes, expiry.
- [ ] `revoke()` → `revokeToken(refresh_token)`, then delete the file even if revoke fails
      (and say so).

### 6.3 `src/cli/auth.ts`
- [ ] `npm run auth` (consent), `--status`, `--revoke`, `--help`.
- [ ] Opens the browser with a small platform helper (`cmd /c start "" <url>` on Windows,
      `open` on macOS, `xdg-open` on Linux; arguments passed as an array, not a shell
      string). Always prints the URL too, in case the browser does not open.
- [ ] Prints which account was authorised and where the token file is. Never prints tokens.

**Tests**
- Token store against a temp folder: round trip, missing file, corrupt file, atomic write
  (no `.tmp` left behind), POSIX mode bits (skipped on Windows).
- `AuthProvider` with a fake OAuth client: each numbered step above; the `tokens` event keeps
  the old refresh token when Google sends only a new access token.
- `parseCallback`: good callback, wrong state, `access_denied`, missing code.
- `SCOPES` snapshot: exactly the approved list. A change makes this test fail on purpose.

**Live check (needs credentials):** `npm run build && npm run auth`, complete consent with
the test account, then `npm run auth -- --status`. If credentials are missing, mark BLOCKED.

**Exit criteria:** unit tests pass; the live check passes or is recorded as BLOCKED.

---

## 7. P5 — Docs append (can run in parallel with P6)

### 7.1 `src/google/docs-index.ts` (pure)
- [ ] `analyzeBody(body)` → `{ insertIndex, trailingEmptyParagraphs, isEmpty, lastParagraphText }`
      (arch §8.2). Throws `GOOGLE_API_ERROR` if the last element is not a paragraph.
- [ ] `buildInsertText({ prefixRule, text, heading?, timestamp? })` using the separator table in
      arch §8.3. Normalise `\r\n` → `\n` in `text`.
- [ ] `planAppend(body, input, now: Date, timeZone)` → `{ insertText, requests }` where
      `requests` is, in order:
  1. `insertText` at `{ index: insertIndex }`,
  2. `deleteParagraphBullets`, `updateParagraphStyle` (`NORMAL_TEXT`) and `updateTextStyle`
     (`fields: "*"`) over the new range (arch §8.3 "Style inheritance"),
  3. `updateParagraphStyle` (`HEADING_2`) over the heading line, if `heading` is set.
- [ ] `formatTimestamp(now, timeZone)` → `YYYY-MM-DD HH:mm <zone abbreviation>`, built from
      `Intl.DateTimeFormat(...).formatToParts` so the output does not depend on the machine locale.
- [ ] `documentEndsWith(body, insertText)`: plain text of the body's trailing paragraphs ends
      with `insertText + "\n"`. Used to verify an ambiguous write.

All index maths uses JavaScript string `.length`, which already counts UTF-16 code units like
the Docs API does.

### 7.2 `src/google/docs-service.ts`
- [ ] `class DocsService { constructor({ docsFor, auth, config, logger, sleep, now }) }` where
      `docsFor(oauthClient)` returns a Docs client (built in `google/clients.ts`, faked in tests).
- [ ] `appendText({ documentId, text, addSeparatorNewline, heading?, insertTimestamp })`:
  1. `auth.getClient()` (auth errors surface before anything else).
  2. Loop `attempt = 1..DOCS_MAX_WRITE_ATTEMPTS`:
     - `documents.get({ documentId, fields: "revisionId,body.content" }, { timeout, retry: false })`
       wrapped in `withRetry` (reads are safe to retry).
     - `planAppend(...)`.
     - `documents.batchUpdate({ documentId, requestBody: { requests,
       writeControl: { requiredRevisionId } } }, { timeout, retry: false })`.
     - Success → return `{ documentId, appendedCharacters: insertText.length }`.
     - `isRevisionMismatch` → log `docs.append.revision_conflict`, continue the loop.
     - `isAmbiguousWriteFailure` → re-fetch: revision unchanged → continue; changed and
       `documentEndsWith` → return success with `verified: true`; otherwise →
       `OPERATION_OUTCOME_UNKNOWN`.
     - Anything else → `mapGoogleError(err, { kind: "write" })`.
  3. Loop exhausted → `GOOGLE_API_ERROR` "the document kept changing; try again shortly"
     (`retryable: true`, because nothing was written).
- [ ] Per-call log fields: `doc_hash`, `attempt`, `outcome`. No text.

### 7.3 `src/tools/docs-append.ts`
- [ ] Exports a tool definition object `{ name, title, description, inputSchema,
      outputSchema, annotations, createHandler(deps) }` with **no MCP SDK import**.
- [ ] Description text exactly as arch §6.4; every schema field has a `.describe()`.
- [ ] Handler: `resolveDocumentId` → length/control-character checks → `DocsService.appendText`
      → `{ success: true, message, document_id, document_url, appended_characters }`.
- [ ] `document_url` in the result is always rebuilt as
      `https://docs.google.com/document/d/<id>/edit`, never echoed from input.

**Tests**
- `tests/fixtures/docs/`: empty doc, one line, trailing one blank, trailing two blanks, ends
  with a table, ends with a bullet list, ends with a heading, contains emoji/CJK. Built with a
  small `makeBody([...paragraphs])` helper so indexes are always consistent; replaced or
  extended with real captured responses in P8.
- `analyzeBody` / `planAppend`: every row of the separator table × `add_separator_newline`
  true/false; heading range; timestamp position; style ranges never start before
  `insertIndex` (+1 when the prefix is not empty); emoji before the insert point.
- A small **Docs simulator** in `tests/helpers/fake-docs.ts` that applies `insertText`
  requests to a fixture and bumps the revision. Assert the original content is a byte-for-byte
  prefix of the result (preservation, PS acceptance criterion 6).
- `DocsService` with the fake client, one test per branch in 7.2 step 2, plus:
  `batchUpdate` is called at most once per revision ID; reads are retried, writes are not
  retried by the library (`retry: false` passed); 403 → `PERMISSION_DENIED`; 404 →
  `RESOURCE_NOT_FOUND`; no `create` method is ever called.
- Tool handler: both ID and URL, neither, both given, bad URL, empty text, text over the limit.

**Exit criteria:** all tests pass; coverage of `docs-index.ts` and `docs-service.ts` ≥ 95 %
of lines.

---

## 8. P6 — Gmail send (can run in parallel with P5)

### 8.1 `src/google/mime.ts` (pure)
- [ ] `buildMimeMessage({ to, cc?, bcc?, replyTo?, subject, body, bodyType })` → string, per
      arch §7.1. Header order fixed; CRLF line endings; headers only for fields that are set.
- [ ] Subject: plain if printable ASCII, otherwise RFC 2047 `=?UTF-8?B?…?=` words of at most
      75 characters, split on UTF-8 character boundaries (never in the middle of a
      multi-byte character), folded with `CRLF + space`.
- [ ] Body: normalise line endings to CRLF, UTF-8 encode, base64, wrap at 76 characters.
- [ ] `toGmailRaw(message)` → base64url without padding.

### 8.2 `src/google/gmail-service.ts`
- [ ] `class GmailService { constructor({ gmailFor, auth, config, logger }) }`.
- [ ] `sendEmail(message)`:
  1. `auth.getClient()` (refreshes first, so expired auth never looks like an ambiguous send).
  2. Build raw MIME.
  3. **Exactly one** call: `users.messages.send({ userId: "me", requestBody: { raw } },
     { timeout, retry: false })`.
  4. Success needs a response with an `id`. A 2xx without `id` → `OPERATION_OUTCOME_UNKNOWN`.
  5. Errors → `wasNeverDelivered` → `NETWORK_ERROR` (retryable); otherwise
     `mapGoogleError(err, { kind: "write" })`. Ambiguous message: "Gmail may have sent this
     email. Check the Sent folder before trying again."
- [ ] No loop and no `withRetry` anywhere in this file. A unit test reads the source file and
      fails if `withRetry` is imported, as a guard against future changes.

### 8.3 `src/tools/gmail-send.ts`
- [ ] Same definition shape as the Docs tool; description exactly as arch §6.3.
- [ ] Handler: build address lists → validate each → duplicate check (D3) → count limit →
      subject single-line, non-blank, length → body non-blank, byte size → `body_type`
      default `"text"` → `GmailService.sendEmail` → `{ success: true, message, message_id,
      thread_id }`.

**Tests**
- MIME: each optional header present only when given; Bcc present only with `bcc`; ASCII and
  non-ASCII subjects (emoji, Hindi, Japanese) decode back to the original; a subject long
  enough to need folding; body round trip through base64; `text/html` when asked; result has
  no `+`, `/` or `=`.
- Service with a fake Gmail client: success; 400 / 401 / 403 / 404 / 429 mapping; timeout,
  `ECONNRESET` and 503 → `OPERATION_OUTCOME_UNKNOWN` **with `send` called exactly once**;
  `ENOTFOUND` → `NETWORK_ERROR` retryable; expired auth → `AUTH_EXPIRED` and `send` never called.
- Tool handler: every validation rule in arch §6.3, including whitespace-only fields, a
  string vs. array `to`, 51 recipients, and duplicates across `to`/`bcc`.

**Exit criteria:** all tests pass; no test can reach the network (the fake client is the
only Gmail client available in `tests/unit`).

---

## 9. P7 — MCP server wiring and entry point

### 9.1 `src/server.ts`
- [ ] `createServer(deps): McpServer` with `name: "google-workspace-mcp"` and the version from
      `package.json`.
- [ ] Registers the two tool definitions with `registerTool`. Nothing else is registered: no
      resources, prompts or extra tools.
- [ ] `wrapHandler(def)`:
  - new `request_id` (UUID) and start time,
  - `try { result = await handler(args) } catch (err) { result = failure(toPublicError(err)) }`,
  - returns `{ content: [{ type: "text", text }], structuredContent: result, isError: !result.success }`,
  - writes the audit log line (arch §12).
- [ ] **Output schema shape:** declare one flat object that is valid for both outcomes
      (`success: boolean`, success fields optional, `error` optional). Some SDK and client
      versions validate `structuredContent` against `outputSchema` even when `isError` is
      true, so a success-only schema would break error results.

### 9.2 `src/index.ts`
- [ ] `loadDotEnv` → `loadConfig` (on `ConfigError`: print the message to stderr, exit 1).
- [ ] Build logger, `AuthProvider`, `clients.ts` factories, services, `createServer`.
- [ ] Connect `StdioServerTransport`. Log `server.started` (version, Node version, token file
      present yes/no) to stderr.
- [ ] Shut down cleanly on `SIGINT`, `SIGTERM` and stdin close.
- [ ] `unhandledRejection` → log and continue; `uncaughtException` → log and exit 1 (process
      state is unknown at that point). Tool errors never reach these handlers because of
      `wrapHandler`.
- [ ] Missing token file does **not** stop start-up (arch §9.4).

### 9.3 `src/google/clients.ts`
- [ ] `gmailFor(auth)` and `docsFor(auth)` using `@googleapis/gmail` / `@googleapis/docs`
      (or `googleapis`), with a `User-Agent` suffix `google-workspace-mcp/<version>`.

**Tests** (`tests/unit/server.test.ts`, using the SDK's `InMemoryTransport` and `Client`)
- `tools/list` returns exactly `gmail_send_email` and `google_docs_append_text`, with titles,
  descriptions mentioning the side effect, required fields, the `body_type` enum, defaults
  and annotations as in arch §6.2. Store this as a snapshot so any change is reviewed.
- A call with fake services returns matching `structuredContent` and text.
- A handler that throws returns `INTERNAL_ERROR`, and the **next** call still works.
- **Log canary test:** run both tools with canary strings in every field (body, subject,
  addresses, text, heading, doc ID) and with a fake token in a thrown error; capture stderr;
  assert none of the canaries appear and the doc ID appears only as its hash.
- Check what the installed SDK does with arguments that fail the input schema (protocol
  error or `isError` result). Write the test to match and document the behaviour in the
  README. Keep zod input schemas to types, required fields and enums; do the detailed
  checks in the handlers so most mistakes return the FR-5 error envelope.
- Process test: spawn `node dist/index.js` with no token file using the SDK's
  `StdioClientTransport`, list tools, call one, confirm `AUTH_REQUIRED`, and confirm stdout
  contained only valid JSON-RPC.

**Manual check:** `npx @modelcontextprotocol/inspector node dist/index.js` shows both tools
and returns `AUTH_REQUIRED` when called without a token.

**Exit criteria:** tests pass; Inspector check done; the smoke test from P1 is removed.

---

## 10. P8 — Integration tests (needs Google credentials)

### 10.1 Test resources (prepared by the owner)

| Resource | Purpose |
|---|---|
| Dedicated test Google account, added as a test user on the consent screen | Never a personal or production account |
| `INTEGRATION_TEST_DOC_ID` | A doc the test account can edit, containing some starting text |
| `INTEGRATION_READONLY_DOC_ID` | A doc shared with the test account as **viewer** only |
| `INTEGRATION_TEST_RECIPIENT` + `INTEGRATION_RECIPIENT_ALLOWLIST` | A mailbox you control; the recipient must be in the allowlist |
| `RUN_INTEGRATION_TESTS=1` | Master switch |

`tests/integration/env.ts` skips the whole suite (`describe.skipIf`) unless every variable is
set and the recipient is in the allowlist. Email tests also need
`RUN_INTEGRATION_EMAIL_TESTS=1`, so doc tests can run without sending mail.

### 10.2 Tests
- [ ] **Auth:** `AuthProvider.getClient()` succeeds; granted scopes match `SCOPES` exactly.
- [ ] **Docs append preserves content:** snapshot `body.content` text → append
      `"IT-<uuid>"` through the full server over stdio → re-read → the old text is an exact
      prefix and the doc ends with the marker.
- [ ] **Separator behaviour on the real API:** append twice; check one blank line between them.
- [ ] **Heading + bullet inheritance:** append with `heading` after a bullet list; check the
      heading is `HEADING_2` and the body text is `NORMAL_TEXT` with no bullet.
- [ ] **Revision conflict, real error shape:** read revision, make a second edit, then send a
      `batchUpdate` with the stale `requiredRevisionId` through the raw client; assert
      `isRevisionMismatch` recognises it. Save the sanitised error as a P3 fixture.
- [ ] **Errors:** made-up valid-format doc ID → `RESOURCE_NOT_FOUND`; read-only doc →
      `PERMISSION_DENIED`; a Sheets file ID → `RESOURCE_NOT_FOUND` with the "only Google Docs"
      hint.
- [ ] **Email (second opt-in flag):** send to the allowlisted recipient with subject
      `"IT-<uuid>"`; assert `success` and a non-empty `message_id`. Arrival is confirmed
      manually (D9) and recorded in the final report.
- [ ] **Revoked / expired auth:** covered by unit-test mocks; checked once manually with a
      copy of the token file and `npm run auth -- --revoke` (manual checklist item).
- [ ] Capture a real `documents.get` response from the test doc, strip the text, and add it
      to `tests/fixtures/docs/`.

**Exit criteria:** suite passes against the test account, or the phase is recorded as
BLOCKED with the missing resource named.

---

## 11. P9 — MCP client verification

For each client: add the config, restart it, confirm the two tools appear, check whether it
asks for confirmation before the call, run one append and one send, and record the result.

| Client | How to connect (stdio) | Notes |
|---|---|---|
| Antigravity | Its MCP config (`mcpServers` entry like arch §13) | Required by PS §1 |
| Claude Code | `claude mcp add google-workspace -- node C:/NextLeap/mcp_server/dist/index.js` | Optional |
| Claude Desktop | `claude_desktop_config.json` → `mcpServers` | Optional |
| VS Code / other IDE agents | Their MCP settings | Optional |
| ChatGPT and other hosted-only clients | Need a remote transport | **Not supported in V1.** Say so in the README (arch §16) |

Record for each tested client: client version, date, tools discovered (yes/no), confirmation
prompt shown (yes/no), append result, send result. Only clients in this table with a passing
row are listed as supported in the README (PS acceptance criterion 14).

**Exit criteria:** Antigravity row passes, or is BLOCKED with the reason.

---

## 12. P10 — Documentation

### `README.md`
- [ ] What it does and does not do (two tools; non-goals from PS §4).
- [ ] **Whose account is used:** the one that ran `npm run auth`, single-user, local only.
- [ ] Prerequisites: Node ≥ 22.9, a Google account, a Google Cloud project.
- [ ] **Google Cloud setup**, step by step:
  1. Create or select a project.
  2. Enable **Gmail API** and **Google Docs API**.
  3. OAuth consent screen: External (or Internal for Workspace), **Testing** mode, add the
     account as a test user, add the scopes.
  4. Create credentials → OAuth client ID → **Desktop app**. Copy ID and secret into `.env`.
- [ ] **Scopes and what they allow:** `gmail.send` (send only, no reading); `documents`
      (read **and edit every** doc the account can open, broader than append); `openid`/`email`
      if D1. Note that unverified apps show a warning and that Testing-mode refresh tokens
      expire after 7 days, so `npm run auth` must be re-run.
- [ ] Install / build / auth / run / test commands (exact, copy-pasteable, PowerShell and bash).
- [ ] Running in Antigravity and the other clients that passed P9, with config examples using
      absolute paths.
- [ ] **Local stdio vs remote hosting:** V1 is local stdio only; what remote would need (arch §16).
- [ ] Tool reference: inputs, defaults, limits, outputs, error codes and what to do for each.
- [ ] Behaviour notes: plain-text append (no Markdown), first tab only, separator rules,
      timestamp format, input-schema validation behaviour found in P7.
- [ ] Security notes: token file location and protection (Windows ACL note), what is logged,
      never paste tokens into chat.
- [ ] **Troubleshooting:** `AUTH_REQUIRED`, `AUTH_EXPIRED` / `invalid_grant`, "access blocked:
      app not verified", `redirect_uri_mismatch` / port in use, `PERMISSION_DENIED` on a doc,
      `OPERATION_OUTCOME_UNKNOWN` (check Sent folder / doc before retrying), client cannot
      find `node` (use the absolute path to `node.exe`), server starts from the wrong folder.
- [ ] Known limitations.

### Other files
- [ ] `.env.example`: every variable from arch §13, placeholder values, one comment each,
      real values never included.
- [ ] `docs/manual-test-checklist.md`: short checklist covering the 14 acceptance criteria,
      revoke/re-auth, a view-only doc, a doc ending in a bullet list, a non-ASCII subject, a
      Bcc recipient who does not show in the received headers, and the client confirmation
      prompts.
- [ ] Keep `architecture.md` matching what was built.

**Exit criteria:** someone else can go from a clean clone to a working append by following
only the README (PS acceptance criterion 1). Do one dry run in a fresh folder.

---

## 13. P11 — Security review

| Check | How |
|---|---|
| No secrets in the repo | `git grep -nE "ya29\.\|1//0\|GOCSPX-\|client_secret"` returns only placeholders/docs |
| Ignore rules work | `git check-ignore .env .local/google-token.json client_secret_x.json` lists all three |
| Scopes | `SCOPES` snapshot test matches the approved list; no `gmail.readonly`, `gmail.modify`, `mail.google.com`, `drive` |
| No stdout writes in the server | ESLint `no-console` clean; process test from P7 passes |
| Send is never retried | Gmail single-call tests pass; `withRetry` guard test passes; `retry: false` asserted |
| Append is never duplicated | Revision-guard tests pass; at most one `batchUpdate` per revision |
| Logs are clean | Canary test passes; one manual run with `LOG_LEVEL=debug`, then search stderr for the body/text used |
| Errors are safe | Error-mapping test that public messages contain no Google response text |
| URL validation | Lookalike-host tests pass |
| No generic actions | `tools/list` snapshot shows exactly two tools; ESLint bans network modules in `src/tools` |
| Dependencies | `npm audit --omit=dev` has no high/critical issues, or each one is explained |
| No vendor agent SDKs | `npm ls` shows no OpenAI / Anthropic / Gemini / Antigravity SDK packages |

**Exit criteria:** every row passes or has a written explanation.

---

## 14. P12 — Final report

Deliver in the PR description or a `FINAL_REPORT.md`, as required by PS §16–17:

1. Architecture summary (link to `architecture.md`; list any changes made during the build).
2. Files created.
3. Exact commands: install, build, auth, run, unit test, integration test.
4. Test evidence: commands run, pass/fail counts, date. Every BLOCKED or skipped item with
   its reason. Nothing claimed that was not run.
5. Google Cloud configuration still required, if any.
6. MCP client config example for stdio, and the P9 results table.
7. Decisions D1–D9: confirmed or assumed.
8. Known limitations and suggested next steps (for example remote hosting, `tab_id`,
   display names, attachments — all need approval first, PS §4).

---

## 15. Acceptance criteria → evidence

| # | Acceptance criterion (PS §14) | Proven by |
|---|---|---|
| 1 | Starts from documented instructions | P10 clean-folder dry run |
| 2 | Client connects and sees both tools | P7 `tools/list` test, P9 table |
| 3 | Email sent, correctly formatted | P6 MIME tests, P8 email test + manual Sent check |
| 4 | Gmail rejects bad input clearly | P6 tool-handler tests |
| 5 | Text appended to an existing doc | P5 service tests, P8 append test |
| 6 | Existing content preserved, no new doc | P5 simulator prefix test, P8 snapshot test, no `create` call |
| 7 | URLs/IDs handled, other domains rejected | P2 URL tests |
| 8 | Predictable success/failure shape | P7 server tests, output schema snapshot |
| 9 | Scopes limited | P4 `SCOPES` snapshot, P8 granted-scope test |
| 10 | No secrets or content in logs | P2 redaction tests, P7 canary test, P11 manual run |
| 11 | Unit tests pass; integration tests documented and safe | `npm test` output, P8 gating, README |
| 12 | Required repo files and README sections | P10 checklist |
| 13 | No vendor agent SDKs in core | P1 dependency list, P11 `npm ls` check, ESLint rules |
| 14 | No untested compatibility claims | P9 table drives the README list |

---

## 16. Risks and mitigations

| Risk | Effect | Mitigation |
|---|---|---|
| MCP SDK API differences (`registerTool`, `outputSchema`, input validation behaviour, zod version) | Build errors or wrong error shapes | Pin the SDK version; P1 zod check; P7 tests written against the installed version |
| Docs revision-mismatch error text is not documented precisely | Conflicts treated as generic errors (safe but less helpful) | Capture the real error in P8; fallback treats an unrecognised 400 on write as "not applied" only if a re-fetch shows the revision unchanged |
| Inherited paragraph or text style on append | Text appears as bullets/heading | Style-reset requests in the same `batchUpdate` (arch §8.3); P8 bullet test |
| Testing-mode refresh tokens expire after 7 days | `AUTH_EXPIRED` each week | Clear message + README note; publishing the app needs Google verification (out of scope) |
| MCP client launches from another folder or without `.env` | Config not found | Paths resolved from the project root; client `env` block supported; troubleshooting entry |
| Windows file permissions cannot be set like POSIX `0600` | Token readable by other local admins | Store in the user profile; README note |
| `gmail.send` cannot read mail, so delivery cannot be auto-checked | Weaker automated evidence | D9: message ID + manual Sent check, recorded in the report |
| No Google credentials during the build | P8/P9 cannot run | Everything else is built and tested with fakes; P8/P9 reported as BLOCKED |
