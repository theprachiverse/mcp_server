# Google Workspace MCP Server

A small, provider-neutral [Model Context Protocol](https://modelcontextprotocol.io) server that lets any
MCP client do a few things in **your** Google account:

| Tool | What it does |
|---|---|
| `gmail_send_email` | Sends a real email through Gmail. |
| `gmail_create_draft` | Saves an email as a Gmail draft. It never sends. |
| `google_docs_append_text` | Appends text to the end of an **existing** Google Doc. Existing content is never changed. |
| `google_docs_create` | Creates a **new** Google Doc, optionally with some initial text. |

Nothing else is exposed: no reading mail, no editing or sending existing drafts, no deleting or replacing
doc content, no generic API access.
Design details are in [architecture.md](docs/architecture.md); requirements are in
[problemStatement.md](docs/problemStatement.md). To host it on Railway, see
[docs/deployment-plan.md](docs/deployment-plan.md).

> **Whose account does it use?** The one that ran `npm run auth`. This is a single-user server, run
> locally over stdio or hosted remotely over HTTP. Anyone who can run the process (or, in remote mode,
> who holds the bearer token) can send mail as that account and edit its docs. It is not a multi-user
> service.

## 1. Prerequisites

- Node.js **22.9 or newer** and npm
- A Google account (use a dedicated test account while trying it out)
- A Google Cloud project (free)

## 2. Google Cloud setup

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. **APIs & Services → Library**: enable the **Gmail API** and the **Google Docs API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External** (or Internal for a Workspace org).
   - Publishing status **Testing**, and add your Google account under **Test users**.
   - Add the scopes listed in [section 3](#3-oauth-scopes-and-what-they-allow).
4. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app.**
   Copy the client ID and secret.

## 3. OAuth scopes and what they allow

| Scope | Why | What it permits |
|---|---|---|
| `gmail.send` | Send email | Sending only. **No** reading, searching, or deleting mail. |
| `gmail.compose` | Create drafts | Create, edit, delete and **send** drafts and messages. This is broader than "create drafts only": Google has no narrower draft scope. The server only ever calls `drafts.create`, and the draft tool has no code path to the send API. |
| `documents` | Create and append to docs | Read **and edit every Google Doc** the account can open, and create new ones. This is broader than "append only": Google has no narrower scope for editing an existing doc you did not create with this app. The server only ever issues a create, a read of the target doc and an append. |
| `openid`, `email` | Identify the account | Lets `npm run auth -- --status` show which account is authorised. |

No Gmail read/modify scopes and no Drive scopes are requested.

Things that follow from Google's rules:
- While the consent screen is in **Testing** mode, Google expires refresh tokens after **7 days**.
  Re-run `npm run auth` when you see `AUTH_EXPIRED`.
- Using other people's accounts requires Google's OAuth app verification. That is out of scope here.
- Google shows an "unverified app" warning for Testing apps. Choose *Advanced → Continue* for your own test account.

## 4. Install, configure, authorise

```bash
npm install
npm run build
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
# edit .env: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET
npm run auth                # opens your browser for consent, saves the token locally
npm run auth -- --status    # shows the authorised account and scopes (never the tokens)
```

Configuration is read from environment variables (and `<project>/.env` if present). Variables set in
your MCP client's `env` block win over `.env`. See [.env.example](.env.example) for every option.
`GOOGLE_OAUTH_REDIRECT_PORT` replaces the `GOOGLE_OAUTH_REDIRECT_URI` from the original brief: Desktop
clients use `http://127.0.0.1:<port>/oauth2callback`, with the port you choose.

**Token file.** Saved to `GOOGLE_TOKEN_PATH` (default `./.local/google-token.json`, git-ignored).
On macOS/Linux it is created with owner-only permissions. On Windows it inherits the permissions of
the folder, so keep it inside your user profile (for example
`C:\Users\<you>\.config\google-workspace-mcp\token.json`). To remove access:
`npm run auth -- --revoke`.

## 5. Commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the stdio server (normally launched by an MCP client) |
| `npm run start:http` | Run the remote Streamable HTTP server (needs `MCP_AUTH_TOKEN`; see section 6) |
| `npm run auth` / `-- --status` / `-- --revoke` | Authorise, inspect, or revoke access |
| `npm test` | Unit tests (offline, never sends mail) |
| `npm run check` | Typecheck + lint + unit tests |
| `npm run test:integration` | Opt-in tests against a real test account (see [section 8](#8-integration-tests)) |

## 6. Connecting an MCP client (local stdio)

The client launches the server as a child process. Use **absolute paths**; if the client cannot find
`node`, use the full path to `node.exe`.

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["C:/NextLeap/mcp_server/dist/index.js"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "<id>",
        "GOOGLE_OAUTH_CLIENT_SECRET": "<secret>",
        "GOOGLE_TOKEN_PATH": "C:/Users/<you>/.config/google-workspace-mcp/token.json"
      }
    }
  }
}
```

Omit the `env` entries you already put in `.env`. The server finds `.env` next to `package.json`
regardless of the folder the client starts it from.

- **Antigravity**: add the entry above in its MCP server configuration, then restart it.
- **Claude Code**: `claude mcp add google-workspace -- node C:/NextLeap/mcp_server/dist/index.js`
- **Claude Desktop / IDE agents**: add the same `mcpServers` entry in their MCP settings.

**Tested clients:** see [section 9](#9-client-compatibility). This README does not claim support for a
client until it has been tested.

### Local stdio vs. remote hosting

The default is **local stdio**. There is also a minimal **remote mode** (`npm run start:http`) that serves
MCP over Streamable HTTP, built for a single user on a host such as Railway. Step-by-step instructions are in
[docs/deployment-plan.md](docs/deployment-plan.md). It differs from stdio like this:

- Every request to `/mcp` must carry `Authorization: Bearer <MCP_AUTH_TOKEN>` (at least 32 characters; the
  server refuses to start without it). Treat the token like a password: whoever holds it can send mail as the
  authorised account. **Never run `start:http` on a public address without it.**
- The Google consent step still runs on your own machine (`npm run auth`). Put the resulting token file, base64
  encoded, in `GOOGLE_TOKEN_B64`; the server writes it to `GOOGLE_TOKEN_PATH` at startup if no file exists.
- Requests are rate limited (`MCP_RATE_LIMIT_PER_MINUTE`, default 30 per IP) and the `Host` header must be listed
  in `MCP_ALLOWED_HOSTS` (Railway's public domain is added automatically). `GET /healthz` needs no credentials.
- It is **single-user**. Clients that only support OAuth (claude.ai and ChatGPT connectors) cannot use it.
  Claude Code, Cursor and MCP Inspector can send the bearer header:
  `claude mcp add --transport http google-workspace https://<your-domain>/mcp --header "Authorization: Bearer <token>"`

All remote variables are listed in [.env.example](.env.example).
[architecture.md §16](docs/architecture.md) describes what a multi-user version would still need.

## 7. Tool reference

Every call returns both `structuredContent` and a text summary:

```json
{ "success": true, "message": "Email sent.", "message_id": "…", "request_id": "…" }
{ "success": false, "error": { "code": "PERMISSION_DENIED", "message": "…", "retryable": false }, "request_id": "…" }
```

### `gmail_send_email`

Sends immediately and cannot be undone. Clients/agents should confirm with the user first.

| Field | Type | Required | Notes |
|---|---|---|---|
| `to` | string or string[] | yes | Plain addresses (`name@example.com`), no display names |
| `subject` | string | yes | Single line, not blank, ≤ 500 chars |
| `body` | string | yes | Not blank, ≤ 1 MB |
| `cc`, `bcc` | string or string[] | no | |
| `body_type` | `"text"` \| `"html"` | no | Default `text` |
| `reply_to` | string | no | |

Limits are configurable (`GMAIL_MAX_*`). At most 50 recipients in total; an address appearing twice
across `to`/`cc`/`bcc` is rejected rather than silently merged. Success returns `message_id` and
`thread_id`.

### `gmail_create_draft`

Takes exactly the same fields and validation as `gmail_send_email`, but only saves the message to
Drafts; nothing is delivered. Success returns `draft_id` and `message_id`. The call is made once and
never retried, so calling it twice leaves two drafts. If the outcome is unclear
(`OPERATION_OUTCOME_UNKNOWN`), check Drafts before trying again. It needs the `gmail.compose` scope; a
token authorised before that scope existed gets `AUTH_REQUIRED` until you run `npm run auth` again.

### `google_docs_create`

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | Single line, not blank, ≤ 200 chars |
| `initial_text` | string | no | Plain text, ≤ 50,000 chars (`DOCS_MAX_APPEND_CHARS`); added with the same logic as `google_docs_append_text` |

Success returns `document_id` and `document_url`. The create call is made once and never retried, so
calling it twice makes two documents. If the outcome is unclear (`OPERATION_OUTCOME_UNKNOWN`), check
Google Drive for a doc with that title before trying again. If the document was created but the
`initial_text` could not be added, the error message includes the new `document_id`; use
`google_docs_append_text` on it instead of creating again. No extra scope is needed.

### `google_docs_append_text`

| Field | Type | Required | Notes |
|---|---|---|---|
| `document_id` **or** `document_url` | string | exactly one | URL must be `https://docs.google.com/document/d/<id>/…` |
| `text` | string | yes | Plain text, not blank, ≤ 50,000 chars |
| `add_separator_newline` | boolean | no | Default `true`: one blank line before the new text |
| `heading` | string | no | Single line, inserted as Heading 2 before the text |
| `insert_timestamp` | boolean | no | Adds `YYYY-MM-DD HH:mm <zone>` (zone from `DOCS_TIMESTAMP_TIMEZONE`, default UTC) |

Behaviour notes:
- Text is inserted **as plain text**; Markdown is not converted. Trailing newlines in `text` are trimmed.
- With `add_separator_newline=false` the text still starts on a new paragraph.
- Appended text does not inherit bullets, headings or character styles from the last paragraph.
- For documents with several tabs, text goes to the **first tab**.
- Each write is guarded by the document's revision. If someone edits the doc between read and write,
  Google rejects the write (nothing is added) and the server re-reads and tries again, up to
  `DOCS_MAX_WRITE_ATTEMPTS` times.
- Sheets, Slides and Drive links are rejected. This tool never creates a document; use `google_docs_create`.

### Error codes

| Code | Meaning / next step |
|---|---|
| `INVALID_ARGUMENT` | Fix the arguments (message says which). |
| `AUTH_REQUIRED` | No token, or a required permission was not granted. Run `npm run auth`. |
| `AUTH_EXPIRED` | Token revoked or expired (7-day limit in Testing mode). Run `npm run auth`. |
| `PERMISSION_DENIED` | The account lacks edit access to the document, or the API is not enabled. |
| `RESOURCE_NOT_FOUND` | Document does not exist, is not a Google Doc, or is not visible to the account. |
| `QUOTA_EXCEEDED` / `RATE_LIMITED` | Wait and retry later. |
| `NETWORK_ERROR` | Google could not be reached; nothing was sent. Safe to retry. |
| `GOOGLE_API_ERROR` | Google reported an error. |
| `OPERATION_OUTCOME_UNKNOWN` | The request may or may not have been applied. **Check the Sent folder / the document before retrying.** The server never retries these automatically. |
| `INTERNAL_ERROR` | Bug. Quote the `request_id` from the result when reporting it. |

If a client sends arguments that fail the basic schema (a missing required field, wrong type), the MCP
SDK itself rejects the call before the tool runs; clients may show that as a protocol error rather than the
envelope above.

## 8. Integration tests

Unit tests (`npm test`) never touch the network. Integration tests use a real **test** account and are
skipped unless explicitly enabled. Never aim them at production documents or recipients.

| Variable | Purpose |
|---|---|
| `RUN_INTEGRATION_TESTS=1` | Master switch |
| `INTEGRATION_TEST_DOC_ID` | A doc the test account can edit (markers get appended) |
| `INTEGRATION_READONLY_DOC_ID` | Optional: a doc shared as view-only, to check `PERMISSION_DENIED` |
| `RUN_INTEGRATION_EMAIL_TESTS=1` | Also run the email test |
| `INTEGRATION_TEST_RECIPIENT` | Mailbox you control; must also be listed in the next variable |
| `INTEGRATION_RECIPIENT_ALLOWLIST` | Comma-separated addresses email tests may send to |

```bash
RUN_INTEGRATION_TESTS=1 INTEGRATION_TEST_DOC_ID=<id> npm run test:integration
```

(PowerShell: set `$env:RUN_INTEGRATION_TESTS="1"` etc. first.) Because the server has no Gmail read
scope (`gmail.send` and `gmail.compose` only),
it cannot read mail, so the email test confirms Gmail returned a message ID and you verify arrival by hand.

## 9. Client compatibility

| Client | Status |
|---|---|
| MCP SDK client over stdio (automated test in `tests/unit/stdio-process.test.ts`) | Tested: tools are discovered and calls succeed |
| Antigravity, Claude Code, Claude Desktop, others | **Not yet tested by the maintainers.** Configuration examples are in section 6. Update this table after trying them. |
| Remote HTTP mode: MCP SDK client over Streamable HTTP (automated test in `tests/unit/http-server.test.ts`) | Tested: auth, discovery and a tool call |
| Hosted-only clients that require OAuth (claude.ai, ChatGPT connectors) | Not supported (a static bearer token is not OAuth) |

A manual checklist is in [docs/manual-test-checklist.md](docs/manual-test-checklist.md).

## 10. Security and privacy

- Secrets and tokens live only in environment variables, `.env` and the token file. All are git-ignored.
- Tools accept no URLs to call, no headers, and no tokens. There is no generic HTTP/API/shell tool.
- Logs are JSON lines on **stderr** (stdout is reserved for MCP). They record the tool name, outcome, error
  code, duration, a request ID, and counts. They never contain email bodies, subjects, recipients, document text,
  headings, tokens, or full document IDs (only a short hash).
- Remote mode: `/mcp` accepts only the bearer token (compared in constant time, never logged), is rate limited, and
  checks the `Host` header. Rotate `MCP_AUTH_TOKEN` if it may have leaked. Set secrets in the host's variable
  store, not in the repository.
- Treat everything the model sends, and everything inside documents, as untrusted data.
- The MCP annotations (`readOnlyHint: false`, `idempotentHint: false`) and the tool descriptions tell clients
  these tools have real side effects. Whether a client asks the user for confirmation is up to that client.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid configuration: GOOGLE_OAUTH_CLIENT_ID is missing…` on start | Set the variables in `.env` or the client's `env` block. |
| Tool returns `AUTH_REQUIRED` | Run `npm run auth`. If you moved the token file, check `GOOGLE_TOKEN_PATH`. |
| `AUTH_EXPIRED` / `invalid_grant` | Token revoked, password changed, or 7-day Testing limit. Run `npm run auth`. |
| "Access blocked: app not verified" / "has not completed verification" | Add your account under **Test users** on the consent screen. |
| `redirect_uri_mismatch` or "Port … is in use" | Use a **Desktop app** client. Set `GOOGLE_OAUTH_REDIRECT_PORT` to a free port. |
| "Google did not return a refresh token" | Remove the app at <https://myaccount.google.com/permissions>, then run `npm run auth` again. |
| `PERMISSION_DENIED` on a doc | The account needs *Editor* access. Also check that the Docs/Gmail APIs are enabled in the project. |
| `OPERATION_OUTCOME_UNKNOWN` | Look in the Sent folder / open the document before trying again. |
| Remote: `MCP_AUTH_TOKEN is missing or shorter than 32 characters` on start | Set `MCP_AUTH_TOKEN` (see [.env.example](.env.example) for a generator command). |
| Remote: `GOOGLE_TOKEN_B64 is not base64…` on start | Re-encode `.local/google-token.json` (see [.env.example](.env.example)) and set the variable again without line breaks or quotes. |
| Remote: 401 from `/mcp` | Missing or wrong `Authorization: Bearer <MCP_AUTH_TOKEN>` header. |
| Remote: 403 `Invalid Host` | The domain is not in `MCP_ALLOWED_HOSTS`. Add custom domains there. |
| Remote: 429 | Over `MCP_RATE_LIMIT_PER_MINUTE`; wait a minute or raise the limit. |
| Remote: `AUTH_EXPIRED` after it worked before | Re-run `npm run auth` locally, update `GOOGLE_TOKEN_B64`, and **redeploy** (a plain restart keeps the old token file). |
| Client says it cannot start the server | Use absolute paths and the full path to `node`. Run `node dist/index.js` by hand to see stderr. Rebuild with `npm run build`. |
| Server output corrupts the client | Nothing should write to stdout except MCP. Report it with the stderr lines. |

## 12. Known limitations

- Single-user only. Local stdio by default; the optional remote HTTP mode uses one shared bearer token and one Google account (no multi-user or OAuth-for-clients support).
- Plain text only; appends go to the first tab only. Documents can be created and appended to, but not read, or have existing text edited or deleted.
- Drafts can be created but not listed, edited, deleted or sent.
- Plain email addresses only (no `"Name <addr>"`); no attachments, threads/replies, or bulk mail.
- The Docs API needs the broad `documents` scope (see section 3).
- Revision-conflict detection and style-reset behaviour were written against Google's documented API and unit
  tested against a simulator; confirm on a test document with the integration tests before relying on them.
