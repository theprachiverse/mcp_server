import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError } from "../utils/errors.js";

const tokenSchema = z.object({
  refresh_token: z.string().min(1),
  access_token: z.string().optional(),
  expiry_date: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  id_token: z.string().optional(),
});

export type StoredTokens = z.infer<typeof tokenSchema>;

export class TokenStore {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  /** Returns the saved tokens, or null if no file exists. */
  read(): StoredTokens | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AppError("AUTH_REQUIRED", "The token file cannot be read. Run `npm run auth`.");
    }
    try {
      return tokenSchema.parse(JSON.parse(raw));
    } catch {
      throw new AppError(
        "AUTH_REQUIRED",
        "The token file is unreadable or invalid. Run `npm run auth`.",
      );
    }
  }

  /** Atomic write (temp file + rename). Owner-only permissions on POSIX. */
  write(tokens: StoredTokens): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(tokenSchema.parse(tokens), null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, this.filePath);
  }

  delete(): boolean {
    try {
      fs.unlinkSync(this.filePath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  mtimeMs(): number | null {
    try {
      return fs.statSync(this.filePath).mtimeMs;
    } catch {
      return null;
    }
  }
}

export class TokenSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenSeedError";
  }
}

/**
 * Remote hosting: writes the token file from a base64 copy held in a secret variable, but only when
 * no file exists yet (a refreshed file on disk is newer than the variable). Messages never include
 * the value.
 */
export function seedTokenStore(store: TokenStore, base64: string): "seeded" | "exists" {
  if (store.mtimeMs() !== null) return "exists";
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    throw new TokenSeedError("GOOGLE_TOKEN_B64 is not base64 of a JSON token file.");
  }
  const result = tokenSchema.safeParse(parsed);
  if (!result.success) {
    throw new TokenSeedError(
      "GOOGLE_TOKEN_B64 does not contain a valid token file (a refresh_token is required).",
    );
  }
  store.write(result.data);
  return "seeded";
}
