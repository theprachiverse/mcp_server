import { docs } from "@googleapis/docs";
import { gmail } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import type { DocBody, DocsRequest } from "./docs-index.js";

/** Thin ports over the Google clients. Services depend on these, tests supply fakes. */
export interface DocsPort {
  create(title: string): Promise<{ documentId?: string | undefined }>;
  get(documentId: string): Promise<{ revisionId: string; body: DocBody }>;
  batchUpdate(
    documentId: string,
    requests: DocsRequest[],
    requiredRevisionId: string,
  ): Promise<void>;
}

export interface GmailPort {
  send(raw: string): Promise<{ id?: string | undefined; threadId?: string | undefined }>;
  createDraft(raw: string): Promise<{ id?: string | undefined; messageId?: string | undefined }>;
}

export type DocsFactory = (auth: OAuth2Client) => DocsPort;
export type GmailFactory = (auth: OAuth2Client) => GmailPort;

/** Library retries are always off: retry policy lives in our services. */
const requestOptions = (timeout: number) => ({ timeout, retry: false }) as const;

export function createDocsFactory(timeoutMs: number, version: string): DocsFactory {
  return (auth) => {
    const api = docs({
      version: "v1",
      auth,
      userAgentDirectives: [{ product: "google-workspace-mcp", version }],
    });
    return {
      async create(title) {
        const res = await api.documents.create(
          { requestBody: { title } },
          requestOptions(timeoutMs),
        );
        return { documentId: res.data.documentId ?? undefined };
      },
      async get(documentId) {
        const res = await api.documents.get(
          { documentId, fields: "revisionId,body.content" },
          requestOptions(timeoutMs),
        );
        const revisionId = res.data.revisionId;
        if (!revisionId) throw new Error("Docs response had no revisionId");
        return { revisionId, body: (res.data.body ?? {}) as DocBody };
      },
      async batchUpdate(documentId, requests, requiredRevisionId) {
        await api.documents.batchUpdate(
          {
            documentId,
            requestBody: {
              requests: requests as never,
              writeControl: { requiredRevisionId },
            },
          },
          requestOptions(timeoutMs),
        );
      },
    };
  };
}

export function createGmailFactory(timeoutMs: number, version: string): GmailFactory {
  return (auth) => {
    const api = gmail({
      version: "v1",
      auth,
      userAgentDirectives: [{ product: "google-workspace-mcp", version }],
    });
    return {
      async send(raw) {
        const res = await api.users.messages.send(
          { userId: "me", requestBody: { raw } },
          requestOptions(timeoutMs),
        );
        return {
          id: res.data.id ?? undefined,
          threadId: res.data.threadId ?? undefined,
        };
      },
      async createDraft(raw) {
        const res = await api.users.drafts.create(
          { userId: "me", requestBody: { message: { raw } } },
          requestOptions(timeoutMs),
        );
        return {
          id: res.data.id ?? undefined,
          messageId: res.data.message?.id ?? undefined,
        };
      },
    };
  };
}
