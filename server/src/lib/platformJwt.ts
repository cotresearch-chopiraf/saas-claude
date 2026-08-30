import jwt from "jsonwebtoken";

export interface PlatformTokenPayload {
  platformOperatorId: string;
}

// MIDAD Phase D1 — deliberately NOT lib/jwt.ts's TokenPayload{userId,
// companyId}: a platform token must never verify against the tenant
// secret/shape or vice versa (the Phase D report's core rule — COMPANY_SCOPE
// and PLATFORM_SCOPE must be structurally separate, all the way down to the
// signing key). Deriving a distinct key from the SAME provisioned
// JWT_SECRET (rather than requiring a second secret in every environment)
// still gets genuine cryptographic separation: a tenant token's signature
// was computed with a different key and will never verify here, and this
// token's signature will never verify against lib/jwt.ts's secret().
function platformSecret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET is not set");
  return `${value}:platform`;
}

export function signPlatformToken(payload: PlatformTokenPayload): string {
  return jwt.sign(payload, platformSecret(), { expiresIn: "7d" });
}

export function verifyPlatformToken(token: string): PlatformTokenPayload {
  return jwt.verify(token, platformSecret()) as PlatformTokenPayload;
}
