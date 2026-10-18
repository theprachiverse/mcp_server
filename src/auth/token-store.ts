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
