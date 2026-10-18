# Problem Statement: Generic Gmail + Google Docs MCP Server

## 1. Project Overview

Build a secure, reusable **Model Context Protocol (MCP) server** that
exposes a small set of Google Workspace actions to AI assistants and
agentic applications. The initial release must support:

1.  Sending an email through Gmail.
2.  Appending content to an **existing Google Doc** without replacing
    its current content.

The server should be built and tested in Antigravity, but it must not
depend on Antigravity-specific APIs or assumptions. It should be usable
by any MCP-compatible client---including ChatGPT where custom MCP
connections are supported, Claude, Gemini, IDE agents, and other MCP
clients---through the standard MCP protocol.

The goal is to separate the Google Workspace capabilities from any
particular AI provider. The MCP server owns tool definitions,
validation, Google API calls, and safety controls. The connected AI
client discovers and invokes the tools using MCP.

## 2. Problem Statement

AI assistants can draft emails and document updates, but they often
cannot reliably execute these actions in a user's Google Workspace
without provider-specific integrations. Implementing the same workflow
separately for each AI platform creates duplicated code, inconsistent
permissions, and maintenance overhead.

We need one provider-neutral MCP server that exposes well-defined tools
for Gmail and Google Docs. Any compatible agent should be able to
discover the available tools, provide structured arguments, and receive
a clear success or error response. The server must use Google's
supported APIs and OAuth-based authorization, preserve existing document
content, avoid accidental email sends, and keep credentials and user
data secure.

## 3. Goals

-   Implement an MCP server using the official MCP SDK for the selected
    language/runtime.
-   Expose a tool for sending email via the Gmail API.
-   Expose a tool for appending text to an existing Google Doc via the
    Google Docs API.
-   Keep tool schemas and behavior independent of any specific LLM or
    agent vendor.
-   Support local development and testing in Antigravity.
-   Make configuration explicit through environment variables and
    documented setup steps.
-   Validate inputs and return predictable, machine-readable tool
    results.
-   Use least-privilege OAuth scopes and never hard-code or log secrets.
-   Include automated tests, clear error handling, and a
    setup/operations README.

## 4. Non-Goals for Version 1

-   Creating new Google Docs.
-   Replacing, rewriting, or deleting existing document content.
-   Reading or searching all Gmail messages.
-   Reading document contents, summarizing inboxes, or managing labels.
-   Sending attachments, inline images, calendar invites, or bulk email.
-   Supporting arbitrary non-Google email providers.
-   Implementing a web UI or a separate user-management system.
-   Bypassing each MCP client's own support, approval, or security
    requirements.
-   Claiming that one transport/configuration works identically in every
    client. Each client may have its own MCP connection setup and
    remote-server requirements.

These may be considered later, but must not be added to Version 1 unless
explicitly approved.

## 5. Intended Users and Main Workflow

### User story A: Send an email

As a user of an MCP-compatible AI assistant, I want to ask the assistant
to send an email, so that the assistant can prepare the message and
invoke Gmail through a secure, reusable tool.

Expected workflow:

1.  The user asks the assistant to send an email.
2.  The assistant gathers or infers the recipient, subject, and body.
3.  The MCP client invokes the `gmail_send_email` tool with structured
    arguments.
4.  The server validates the arguments and confirms that the required
    fields are present.
5.  The server sends the message using the authenticated Gmail account.
6.  The server returns a concise result with success status and a Gmail
    message identifier when available.
7.  If sending is not explicitly authorized by the user or the calling
    product's interaction model, the agent should ask for confirmation
    before invoking the tool.

### User story B: Append to an existing Google Doc

As a user of an MCP-compatible AI assistant, I want to add new text to
an existing Google Doc while preserving its current content.

Expected workflow:

1.  The user provides a Google Docs URL or document ID and the text to
    append.
2.  The MCP client invokes the `google_docs_append_text` tool.
3.  The server extracts or validates the document ID.
4.  The server verifies that the authenticated account can access and
    edit the document.
5.  The server obtains the document's current structure and calculates a
    valid insertion index at the end of the document.
6.  The server appends the supplied content using the Google Docs API,
    optionally adding a newline separator.
7.  The server returns a success result and the document URL.
8.  The server must not overwrite existing content or silently create a
    new document.

## 6. Functional Requirements

### FR-1: MCP protocol

-   Use a maintained, official MCP SDK for the chosen implementation
    language.
-   Implement standard MCP server initialization, tool discovery, and
    tool invocation.
-   Expose tool names, descriptions, input schemas, and results through
    MCP.
-   Do not use OpenAI-, Anthropic-, Google Gemini-, or
    Antigravity-specific agent APIs inside the core server.
-   Keep Google Workspace API logic in separate modules from MCP
    protocol handling.
-   Support a local development transport appropriate to the chosen SDK
    (for example, stdio).
-   If remote deployment is added, use a supported remote MCP transport
    and secure authentication. Do not expose an unauthenticated public
    server.

### FR-2: Gmail send tool

Tool name: `gmail_send_email`

Required input fields: - `to`: one recipient email address or a
non-empty array of recipient email addresses. - `subject`: email subject
string. - `body`: plain-text email body.

Optional input fields: - `cc`: one email address or an array of
addresses. - `bcc`: one email address or an array of addresses. -
`body_type`: `text` or `html`; default to `text`. - `reply_to`: valid
email address, if supported by the implementation.

Behavior: - Validate all email addresses and reject malformed input. -
Reject empty or whitespace-only recipient, subject, or body values
unless the implementation explicitly documents a valid exception. -
Apply reasonable limits to recipient count and message size; make limits
configurable where practical. - Construct a valid RFC 2822/MIME message
and encode it as required by the Gmail API. - Send using the Gmail API
`users.messages.send` endpoint with `userId="me"`. - Do not accept
arbitrary API URLs, raw authorization headers, or user-supplied OAuth
tokens as tool arguments. - Return a structured result containing
`success`, `message`, and, on success, `message_id` when provided by
Google. - Never report success until the Gmail API confirms successful
submission. - Do not automatically retry an ambiguous send failure if
doing so could send a duplicate email. Explain the uncertainty and allow
the user or agent to decide what to do next. - The server must not send
to additional recipients or modify message content beyond documented
formatting/encoding.

Suggested input schema:

``` json
{
  "to": ["recipient@example.com"],
  "subject": "Meeting follow-up",
  "body": "Thanks for your time today.",
  "cc": [],
  "bcc": [],
  "body_type": "text"
}
```

The implementation may choose a simpler schema if it is easier for MCP
clients to use, but it must document it and support at least one
recipient.

### FR-3: Append-to-existing-Google-Doc tool

Tool name: `google_docs_append_text`

Required input fields: - `document_id`: Google Docs document ID, or a
documented `document_url` field from which the ID can be extracted. -
`text`: non-empty content to append.

Optional input fields: - `add_separator_newline`: boolean; default
`true`. - `heading`: optional heading text to insert before the appended
content, if implemented in Version 1. - `insert_timestamp`: boolean;
default `false`. If enabled, use a clearly documented timezone/format.

Behavior: - Accept only a valid Google Docs document ID or a URL on an
approved Google Docs domain. - Extract the ID safely from standard Docs
URLs. Reject unrelated domains and malformed URLs. - Use the Google Docs
API `documents.get` to retrieve the current document structure and
determine the valid end insertion index. - Append content at the end of
the document body. Preserve all pre-existing content. - Account for
Google Docs structural rules and the final newline/index behavior; do
not assume a fixed index of `1` or blindly append at an invalid index. -
If the document is empty or has only its required terminal newline,
handle that case correctly. - If `add_separator_newline=true`, ensure
the appended content is separated from existing content in a readable
way without introducing excessive blank lines. - Use
`documents.batchUpdate` with an `insertText` request at the computed end
index. - Handle documents that cannot be edited, unsupported document
types, permission errors, and concurrent edits clearly. - Do not create
a document if the supplied document ID is invalid or inaccessible. -
Return `success`, `message`, `document_id`, and `document_url` on
success. - Do not return the entire document content in tool results. -
If the Google Docs API rejects an index or concurrent update, re-fetch
the document structure and retry only when the operation can be
performed safely. Avoid repeated insertion that duplicates content.

Suggested input schema:

``` json
{
  "document_id": "GOOGLE_DOC_ID",
  "text": "## Weekly update\nCompleted the prototype and documented open issues.",
  "add_separator_newline": true
}
```

### FR-4: Tool discovery and descriptions

-   Each tool must have a clear, specific description that tells an
    agent when to use it.
-   Tool descriptions must explain side effects: sending an email sends
    a real message; appending text modifies an existing document.
-   Input schemas must use explicit types, required fields,
    descriptions, and enumerated values where applicable.
-   Avoid vague tools such as `do_google_action` or `execute_api_call`.
-   Do not rely on the agent to infer required parameters from examples
    alone.

### FR-5: Consistent responses

Use a consistent JSON-like response structure for both tools. For
example:

Success:

``` json
{
  "success": true,
  "message": "Email sent successfully.",
  "message_id": "provider-message-id"
}
```

Failure:

``` json
{
  "success": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "The authenticated Google account cannot edit this document."
  }
}
```

Use MCP tool result content in the way required by the selected SDK. If
the SDK supports structured content, return structured data as well as
concise human-readable text.

Recommended error codes: - `INVALID_ARGUMENT` - `AUTH_REQUIRED` -
`AUTH_EXPIRED` - `PERMISSION_DENIED` - `RESOURCE_NOT_FOUND` -
`QUOTA_EXCEEDED` - `RATE_LIMITED` - `GOOGLE_API_ERROR` -
`NETWORK_ERROR` - `OPERATION_OUTCOME_UNKNOWN` - `INTERNAL_ERROR`

Never include access tokens, refresh tokens, client secrets, raw
authorization headers, or unnecessary personal data in errors.

## 7. Architecture Requirements

Use a small modular architecture. Example layout (adapt to the selected
language and SDK):

``` text
google-workspace-mcp/
├── src/
│   ├── index.*                 # Entry point and MCP server lifecycle
│   ├── server.*                # MCP initialization and tool registration
│   ├── config.*                # Environment/configuration validation
│   ├── auth/
│   │   └── google-oauth.*      # OAuth client and token handling
│   ├── google/
│   │   ├── gmail-service.*     # Gmail API operations
│   │   └── docs-service.*      # Google Docs API operations
│   ├── tools/
│   │   ├── gmail-send.*        # Tool schema, validation, orchestration
│   │   └── docs-append.*       # Tool schema, validation, orchestration
│   ├── utils/
│   │   ├── errors.*
│   │   ├── validation.*
│   │   └── logging.*
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── .env.example
├── .gitignore
├── package.json / equivalent
├── README.md
└── problemStatement.md
```

Keep transport, tools, authentication, API clients, and business logic
separate. Exact filenames and extensions may vary by runtime.

## 8. Technology and Google API Requirements

The implementation agent should select one supported runtime and use it
consistently. **Preferred default:** TypeScript on a current supported
Node.js LTS release, using the official MCP TypeScript SDK and Google's
official API client library. If another runtime is chosen, document the
reason and use its official MCP SDK.

Google APIs: - Gmail API: send messages through `users.messages.send`. -
Google Docs API: inspect document structure with `documents.get` and
append with `documents.batchUpdate` / `insertText`.

Google Cloud setup: 1. Create or select a Google Cloud project. 2.
Enable Gmail API and Google Docs API. 3. Configure the OAuth consent
screen and authorized test users as required. 4. Create OAuth client
credentials appropriate for the deployment model. 5. Use a local OAuth
flow for local development; do not embed client secrets in source code.
6. Document how to obtain consent and establish the initial authorized
session. 7. Keep tokens in a protected local location for development,
outside source control. For production, use a suitable secret/token
store and deployment-specific access controls.

Suggested OAuth scopes (request the narrowest scopes that actually
support the selected implementation): - Gmail sending:
`https://www.googleapis.com/auth/gmail.send` - Google Docs append:
`https://www.googleapis.com/auth/documents`

The Docs scope permits document access broader than a single append
operation, so disclose this clearly in setup documentation. Do not
request Gmail read, modify, or full-mailbox scopes unless a future
approved feature needs them. Explain that Google OAuth verification,
consent-screen mode, and access policies may affect use outside test
accounts.

## 9. Authentication and Token Lifecycle

-   Use Google's supported OAuth 2.0 authorization flow.
-   Do not ask users to paste access tokens into prompts or tool
    arguments.
-   Keep OAuth credentials and tokens outside version control.
-   Ensure `.env`, token files, and local credential files are covered
    by `.gitignore`.
-   Validate required configuration at startup and fail with an
    actionable, non-secret error.
-   Handle expired access tokens using the official client library's
    refresh mechanism where applicable.
-   If authorization is missing or revoked, return `AUTH_REQUIRED` or
    `AUTH_EXPIRED` and document how to re-authorize.
-   Never print secrets or tokens to logs.
-   For a single-user local server, document whose Google account is
    being used. For a multi-user remote server, implement per-user OAuth
    and session isolation before claiming multi-user support.
-   Do not silently use a developer's personal account in a shared
    deployment.

## 10. Security, Privacy, and Safety

This server performs real-world actions. Implement the following
safeguards:

-   **Explicit intent:** Tool descriptions must make side effects
    obvious. The agent/client should obtain user confirmation before
    sending an email or modifying a document when the client supports
    confirmation workflows, especially when recipients or text are
    ambiguous.
-   **Least privilege:** Request only the OAuth scopes needed for the
    two tools.
-   **Input validation:** Validate email addresses, recipient counts,
    document IDs/URLs, content length, and optional values.
-   **Domain validation:** Accept Google Docs links only from approved
    Google Docs domains.
-   **No arbitrary execution:** Never expose a generic shell, arbitrary
    HTTP request, arbitrary Google API method, or code-execution tool.
-   **No secret leakage:** Redact credentials and tokens from errors,
    logs, and returned tool content.
-   **Data minimization:** Do not log email bodies, document text,
    recipient lists, or document contents by default.
-   **Safe errors:** Return actionable messages without dumping provider
    responses that may contain sensitive details.
-   **Rate limits:** Respect Google API quotas and retry guidance. Use
    bounded backoff for safe retryable requests only.
-   **Duplicate prevention:** Do not blindly retry email sends after an
    ambiguous network failure. For document append, prevent duplicate
    insertion during retry handling.
-   **Transport security:** For remote hosting, use HTTPS, authenticate
    MCP clients, restrict origins where applicable, and protect the
    server from unauthorized access.
-   **Auditability:** Log operation type, timestamp, outcome, and a
    correlation/request ID without logging message bodies, document
    text, or secrets.
-   **Prompt injection awareness:** Treat document text, email content,
    and tool arguments as untrusted data. Content inside a document must
    never be interpreted as authority to expand server permissions or
    execute unrelated actions.

## 11. Reliability and Error Handling

-   Validate arguments before calling Google APIs.
-   Use timeouts where supported.
-   Distinguish validation errors, authentication failures, permission
    errors, not-found errors, quota/rate-limit errors, provider
    failures, and unknown outcomes.
-   Apply exponential backoff with jitter only to operations known to be
    safe to retry.
-   Do not automatically repeat a send operation if the request may
    already have been accepted by Gmail.
-   For append failures, re-fetch the document and verify current state
    before deciding whether to retry. If it cannot be determined whether
    the append succeeded, return `OPERATION_OUTCOME_UNKNOWN` rather than
    risking a duplicate.
-   Keep error messages concise and tell the user the next useful step.
-   A failure in one tool must not crash the whole MCP server.

## 12. Configuration

Provide `.env.example` with placeholders and explanatory comments.
Include only the configuration actually used by the implementation.
Example names:

``` dotenv
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=
GOOGLE_TOKEN_PATH=./.local/google-token.json
LOG_LEVEL=info
```

Do not include real values in `.env.example`. If the chosen OAuth flow
uses a different configuration model, document it. Validate
configuration at startup and never print secret values.

## 13. Testing Requirements

### Unit tests

-   Valid and invalid email addresses.
-   Required Gmail fields missing or empty.
-   Recipient lists, CC/BCC, subject/body encoding, and plain-text
    default.
-   Valid Google Docs IDs and URLs; invalid or non-Google domains
    rejected.
-   Correct calculation of insertion index for representative document
    structures.
-   Empty/minimal document and terminal-newline edge cases.
-   Separator newline behavior.
-   Error mapping and secret redaction.
-   Retry behavior, including no blind retry for ambiguous email-send
    outcomes.
-   MCP tool schemas expose accurate names, descriptions, required
    fields, and optional fields.

### Integration tests

Use a dedicated test Google account and test document. Never use
production recipients or documents for automated destructive testing.

-   Authenticate successfully.
-   Send an email to a controlled test mailbox and verify it arrives or
    is visible in the test account's Sent folder.
-   Append a unique marker to a test Google Doc and verify the marker
    appears at the end.
-   Confirm earlier document content remains unchanged.
-   Confirm invalid document IDs, revoked authorization, and
    insufficient permissions return safe errors.
-   Test quota/rate-limit and network-failure handling where practical,
    using mocks for failures that are difficult to reproduce safely.

Integration tests that send real email must be opt-in (for example,
gated by an explicit environment flag and test recipient allowlist).
Unit tests must never send real email.

## 14. Acceptance Criteria

Version 1 is complete only when all criteria below are met:

1.  The server starts using documented instructions in a clean
    development environment.
2.  A compatible MCP client can connect and discover both tools.
3.  `gmail_send_email` sends a correctly formatted email through the
    authenticated Gmail account.
4.  The Gmail tool rejects invalid or incomplete input with clear
    errors.
5.  `google_docs_append_text` appends supplied text to an existing
    Google Doc.
6.  Existing document content is preserved; the tool does not replace
    the document or create a new one.
7.  The append tool handles valid Google Docs URLs and IDs and rejects
    unrelated domains.
8.  Both tools return predictable success and failure structures.
9.  OAuth scopes are limited to those needed for Gmail sending and Docs
    access.
10. No secrets, tokens, email bodies, or appended document text appear
    in ordinary logs.
11. Unit tests pass; integration tests are documented and can be run
    safely against a test account.
12. The repository includes `.env.example`, `.gitignore`, README setup
    steps, Google Cloud/OAuth setup instructions, MCP client
    configuration examples, troubleshooting, and known limitations.
13. The implementation does not contain provider-specific agent SDK
    dependencies in the core tool logic.
14. The implementation does not claim compatibility with a client until
    the required MCP transport and client-side setup have been tested or
    documented.

## 15. Definition of Done / Deliverables

Deliver the following:

-   Working source code for the MCP server.
-   Two registered tools: `gmail_send_email` and
    `google_docs_append_text`.
-   Modular Google API and OAuth implementation.
-   Input validation and safe error mapping.
-   Unit tests and opt-in integration tests.
-   `.env.example` and `.gitignore`.
-   A README with:
    -   Prerequisites.
    -   Google Cloud project and API setup.
    -   OAuth consent and token setup.
    -   Install/build/run/test commands.
    -   How to run locally in Antigravity.
    -   MCP client connection examples for clients that support the
        chosen transport.
    -   A clear distinction between local stdio setup and remote MCP
        hosting.
    -   Security and OAuth scope notes.
    -   Troubleshooting.
-   A concise manual test checklist.
-   No hard-coded secrets, real tokens, or personal account data in the
    repository.

## 16. Suggested Implementation Plan

1.  **Inspect the environment:** Check the available Node.js/runtime
    version and existing repository structure before creating files.
2.  **Initialize project:** Add the MCP SDK, Google API client,
    validation library if useful, test framework, formatter/linter, and
    TypeScript configuration.
3.  **Implement configuration and errors:** Validate startup
    configuration and define consistent safe errors.
4.  **Implement OAuth:** Establish the local authorization flow and
    verify the authenticated Google account without logging secrets.
5.  **Implement Docs append:** Build and unit-test document ID
    extraction, end-index calculation, and append behavior.
6.  **Implement Gmail send:** Build MIME message generation, argument
    validation, and Gmail API submission.
7.  **Register MCP tools:** Publish the two tools with clear
    descriptions and schemas.
8.  **Add tests:** Unit-test logic with mocked Google APIs; add opt-in
    test-account integration tests.
9.  **Test in an MCP client:** Confirm tool discovery, arguments,
    side-effect messaging, and returned results.
10. **Document setup:** Complete README and example client
    configuration.
11. **Review security:** Inspect logs, `.gitignore`, OAuth scopes, retry
    behavior, and accidental secret exposure.
12. **Provide a final report:** Summarize files created, commands run,
    tests passed/failed, setup steps remaining, and known limitations.
    Never claim an unrun test passed.

## 17. Instructions for the Antigravity Coding Agent

Use this document as the source of truth. Before coding, inspect the
repository and report any meaningful existing constraints. Then
implement the complete Version 1 rather than only producing a design or
pseudocode.

Prioritize correctness and safe side effects over extra features. Do not
add tools beyond the two specified actions without approval. Do not
substitute mock implementations for real Google API calls in the final
implementation; mocks are for tests only. If OAuth credentials are not
available, implement the complete OAuth setup path and report that live
integration testing remains blocked until credentials and consent are
configured.

At completion, provide: - A summary of the architecture. - The exact
commands to install, build, run, and test. - The exact Google Cloud
configuration still required, if any. - Example MCP client configuration
for the selected local transport. - Evidence of which tests actually ran
and their outcomes. - Any limitations or decisions that need user
approval.

## 18. Important Compatibility Note

"MCP-compatible" does not mean every AI product can connect to every
server in the same way. A local stdio server generally requires the
client application to launch a local process; a hosted server generally
requires a supported remote transport, network reachability, and
appropriate authentication. Individual clients also vary in whether they
support custom MCP servers, which transports they accept, and how they
request approval for side effects.

Therefore, keep the server provider-neutral, implement the standard MCP
protocol correctly, and document client-specific setup separately. Do
not embed client-specific behavior into the Gmail or Docs service
modules.
