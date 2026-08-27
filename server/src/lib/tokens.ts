import { randomBytes, createHash } from "node:crypto";

// Raw tokens go out in links (email, public quote URL); only their hash is
// ever stored, so a database read alone can't be replayed as the token.
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
