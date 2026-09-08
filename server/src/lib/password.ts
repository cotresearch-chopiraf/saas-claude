import bcrypt from "bcryptjs";

const SALT_ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// AUTH-002: a fixed, pre-derived bcrypt hash of a constant placeholder
// string — never a real or user-supplied password, and never regenerated
// at request time. Callers compare a login attempt against this when no
// matching account exists, so bcrypt.compare() runs the same cost either
// way and account existence can't be inferred from response timing.
export const DUMMY_PASSWORD_HASH = "$2a$10$vnNVE9bCUV5A/zSgiDo/muz/SJe6xrWhDZzjYl6FCTmfxfpGq4wee";
