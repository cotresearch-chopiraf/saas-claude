import jwt from "jsonwebtoken";

export interface ClientPortalTokenPayload {
  clientPortalUserId: string;
  // References clientPortalSessions.id (schema.ts) — checked on every
  // request by middleware/clientPortalAuth.ts, the same
  // revoke-immediately-not-just-on-expiry reason lib/jwt.ts's
  // TokenPayload.sessionId already exists for regular users.
  sessionId: string;
}

// MIDAD Phase B1 — deliberately NOT lib/jwt.ts's TokenPayload{userId,
// companyId,...} or lib/platformJwt.ts's PlatformTokenPayload — a Client
// Portal token must never verify against the tenant or platform secret/
// shape, or vice versa (same COMPANY_SCOPE/PLATFORM_SCOPE separation
// discipline the Phase D report established, extended to a third scope).
// Deriving a distinct key from the SAME provisioned JWT_SECRET (rather
// than requiring a third secret in every environment) still gets genuine
// cryptographic separation: this token's signature was computed with a
// different key than either of the other two token types and will never
// verify against their secret()/platformSecret().
function clientPortalSecret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET is not set");
  return `${value}:client_portal`;
}

export function signClientPortalToken(payload: ClientPortalTokenPayload): string {
  return jwt.sign(payload, clientPortalSecret(), { expiresIn: "7d" });
}

export function verifyClientPortalToken(token: string): ClientPortalTokenPayload {
  return jwt.verify(token, clientPortalSecret()) as ClientPortalTokenPayload;
}
