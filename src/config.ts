import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export interface Config {
  readonly projectRoot: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectPort: number;
  readonly tokenPath: string;
  readonly apiTimeoutMs: number;
  readonly gmailMaxRecipients: number;
  readonly gmailMaxSubjectChars: number;
  readonly gmailMaxBodyBytes: number;
  readonly docsMaxAppendChars: number;
  readonly docsMaxWriteAttempts: number;
  readonly docsTimestampTimezone: string;
  readonly logLevel: "error" | "warn" | "info" | "debug";
  // Remote (Streamable HTTP) mode only. All optional so stdio users need none of them.
  readonly port: number;
  readonly mcpAuthToken: string | undefined;
  readonly mcpAllowedHosts: readonly string[];
  readonly mcpRateLimitPerMinute: number;
  readonly mcpTrustProxy: number;
  readonly googleTokenB64: string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Walks up from this file to the folder holding package.json (works from src/ and dist/). */
export function findProjectRoot(startUrl: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(startUrl));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError("Could not locate the project root (package.json).");
}

/** Loads <root>/.env if present. Variables already in the environment win. */
export function loadDotEnv(root: string): void {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    throw new ConfigError("The .env file exists but could not be parsed.");
  }
}

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const int = (min: number, max: number, def: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));
const required = z.preprocess(emptyToUndefined, z.string().min(1));
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const schema = z.object({
  GOOGLE_OAUTH_CLIENT_ID: required,
  GOOGLE_OAUTH_CLIENT_SECRET: required,
  GOOGLE_OAUTH_REDIRECT_PORT: int(1024, 65535, 53682),
  GOOGLE_TOKEN_PATH: z.preprocess(
    emptyToUndefined,
    z.string().default("./.local/google-token.json"),
  ),
  GOOGLE_API_TIMEOUT_MS: int(1000, 120000, 20000),
  GMAIL_MAX_RECIPIENTS: int(1, 500, 50),
  GMAIL_MAX_SUBJECT_CHARS: int(1, 998, 500),
  GMAIL_MAX_BODY_BYTES: int(1, 18 * 1024 * 1024, 1048576),
  DOCS_MAX_APPEND_CHARS: int(1, 1_000_000, 50000),
  DOCS_MAX_WRITE_ATTEMPTS: int(1, 10, 3),
  DOCS_TIMESTAMP_TIMEZONE: z.preprocess(emptyToUndefined, z.string().default("UTC")),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(["error", "warn", "info", "debug"]).default("info"),
  ),
  PORT: int(1, 65535, 3000),
  MCP_AUTH_TOKEN: optionalString,
  MCP_ALLOWED_HOSTS: optionalString,
  MCP_RATE_LIMIT_PER_MINUTE: int(1, 10_000, 30),
  // Reverse proxies in front of the server. Unset means 1 on Railway (it sets RAILWAY_ENVIRONMENT_NAME), else 0.
  MCP_TRUST_PROXY: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(5).optional()),
  GOOGLE_TOKEN_B64: optionalString,
  RAILWAY_PUBLIC_DOMAIN: optionalString,
  RAILWAY_ENVIRONMENT_NAME: optionalString,
});

/** Comma-separated host names; trims, lower-cases, drops blanks and duplicates. */
function parseHostList(...lists: (string | undefined)[]): string[] {
  const hosts = lists
    .flatMap((l) => (l ?? "").split(","))
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(hosts)];
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates env vars. Error messages name variables but never include their values. */
export function loadConfig(env: NodeJS.ProcessEnv, projectRoot: string): Readonly<Config> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = new Set<string>();
    for (const issue of parsed.error.issues) names.add(String(issue.path[0] ?? "config"));
    throw new ConfigError(
      `Invalid configuration: ${[...names].map((n) => `${n} is missing or invalid`).join("; ")}. See .env.example.`,
    );
  }
  const e = parsed.data;
  if (!isValidTimeZone(e.DOCS_TIMESTAMP_TIMEZONE)) {
    throw new ConfigError(
      "Invalid configuration: DOCS_TIMESTAMP_TIMEZONE is not a valid IANA time zone. See .env.example.",
    );
  }
  return Object.freeze({
    projectRoot,
    clientId: e.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectPort: e.GOOGLE_OAUTH_REDIRECT_PORT,
    tokenPath: path.resolve(projectRoot, e.GOOGLE_TOKEN_PATH),
    apiTimeoutMs: e.GOOGLE_API_TIMEOUT_MS,
    gmailMaxRecipients: e.GMAIL_MAX_RECIPIENTS,
    gmailMaxSubjectChars: e.GMAIL_MAX_SUBJECT_CHARS,
    gmailMaxBodyBytes: e.GMAIL_MAX_BODY_BYTES,
    docsMaxAppendChars: e.DOCS_MAX_APPEND_CHARS,
    docsMaxWriteAttempts: e.DOCS_MAX_WRITE_ATTEMPTS,
    docsTimestampTimezone: e.DOCS_TIMESTAMP_TIMEZONE,
    logLevel: e.LOG_LEVEL,
    port: e.PORT,
    mcpAuthToken: e.MCP_AUTH_TOKEN,
    mcpAllowedHosts: parseHostList(e.MCP_ALLOWED_HOSTS, e.RAILWAY_PUBLIC_DOMAIN),
    mcpRateLimitPerMinute: e.MCP_RATE_LIMIT_PER_MINUTE,
    mcpTrustProxy: e.MCP_TRUST_PROXY ?? (e.RAILWAY_ENVIRONMENT_NAME ? 1 : 0),
    googleTokenB64: e.GOOGLE_TOKEN_B64,
  });
}
