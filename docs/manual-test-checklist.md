# Manual test checklist

Use a **dedicated test Google account**, a throw-away test document, and a mailbox you control.
Tick each item and note the date and client/version.

## Setup
- [ ] `npm install && npm run build` succeeds on a clean clone.
- [ ] `npm run check` is green.
- [ ] `npm run auth` opens the browser, completes, and prints the authorised account.
- [ ] `npm run auth -- --status` shows the right account and only: gmail.send, documents, openid, email.
- [ ] No `.env`, token file, or client secret appears in `git status`.

## Discovery (in the MCP client)
- [ ] The client lists exactly two tools: `gmail_send_email`, `google_docs_append_text`.
- [ ] Descriptions state the side effects (real email / modifies the document).
- [ ] The client asks for confirmation before running either tool (note if it does not).

## Email
- [ ] Send to one recipient; the email arrives with the right subject and body; `message_id` is returned.
- [ ] Send with `cc` and `bcc`: the Bcc recipient receives it and is **not** visible in the headers others see.
- [ ] Non-ASCII subject and body (for example `नमस्ते 🌍`) display correctly.
- [ ] `body_type: html` renders as HTML.
- [ ] A malformed address, blank subject, and blank body are each rejected with a clear message and send nothing.
- [ ] A duplicate address across `to` and `bcc` is rejected.

## Docs
- [ ] Append by document ID: text appears at the end, earlier content is untouched.
- [ ] Append by URL (`…/edit`, and a `/u/1/` URL).
- [ ] Two appends in a row leave exactly one blank line between them.
- [ ] Append to an **empty** document.
- [ ] Append to a doc that ends with a **bullet list**: new text is not a bullet. Same for a doc ending in a **heading**.
- [ ] `heading` produces a Heading 2 line; `insert_timestamp` adds the timestamp line.
- [ ] A Sheets/Slides link, a non-Google URL, and a made-up ID are rejected, and no document is created.
- [ ] A view-only document returns `PERMISSION_DENIED`.
- [ ] Editing the doc by hand while an append runs never duplicates or loses the appended text.

## Auth lifecycle
- [ ] Delete the token file: calls return `AUTH_REQUIRED`. Run `npm run auth`: next call works **without restarting** the client.
- [ ] `npm run auth -- --revoke`, then a call returns `AUTH_REQUIRED`.
- [ ] Revoke the app at <https://myaccount.google.com/permissions> without deleting the file: next call returns `AUTH_EXPIRED`.

## Logs
- [ ] With `LOG_LEVEL=debug`, run one email and one append, then search the client's server log for the body,
      subject, recipient, document text and document ID. None should appear.

## Clients tried
| Client + version | Date | Tools found | Confirmation prompt | Append OK | Send OK | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
