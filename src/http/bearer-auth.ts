import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../utils/logging.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Requires `Authorization: Bearer <token>`. Digests are compared so the comparison takes the same time
 * whatever the lengths. Rejections are logged without the header or the supplied token.
 */
export function bearerAuth(expectedToken: string, logger: Logger) {
  const expected = digest(expectedToken);
  return (req: Request, res: Response, next: NextFunction): void => {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (match?.[1] && timingSafeEqual(digest(match[1].trim()), expected)) {
      next();
      return;
    }
    logger.warn("auth.rejected", { request_id: randomUUID(), ip: req.ip, path: req.path });
    res
      .status(401)
      .set("WWW-Authenticate", "Bearer")
      .json({ error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token." } });
  };
}
