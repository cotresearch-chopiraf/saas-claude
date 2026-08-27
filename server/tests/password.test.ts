import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../src/lib/password.js";
import { hashToken, generateToken } from "../src/lib/tokens.js";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("never stores the plain password in the hash", async () => {
    const hash = await hashPassword("supersecret");
    expect(hash).not.toContain("supersecret");
  });
});

describe("tokens", () => {
  it("hashing the same token twice is deterministic", () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("generates unique tokens", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});
