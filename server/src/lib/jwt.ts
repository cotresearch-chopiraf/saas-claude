import jwt from "jsonwebtoken";

export interface TokenPayload {
  userId: string;
  companyId: string;
  // References userSessions.id (schema.ts) — the row middleware/auth.ts
  // checks on every request to allow revoking this one token immediately
  // (logout, password reset, member removed) without waiting for its 7-day
  // JWT expiry. Required, not optional: every token this codebase issues
  // for a regular user is expected to have a backing session row.
  sessionId: string;
}

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET is not set");
  return value;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, secret(), { expiresIn: "7d" });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, secret()) as TokenPayload;
}
