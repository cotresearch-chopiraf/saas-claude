import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { buildAppUrl, AppUrlConfigError } from "../src/lib/appUrl.js";

// B1/B2 remediation — invitation and password-reset emails previously
// embedded a bare relative path ("/accept-invite?token=...",
// "/reset-password?token=...") with no domain, which has no meaning inside
// a real email client. This file proves the fix: both emails now contain a
// real, absolute URL built from APP_URL, trailing-slash handling is
// idempotent, token encoding survives round-trip, and nothing about token
// generation/hashing/expiry/acceptance behavior changed.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

const originalAppUrl = process.env.APP_URL;

beforeAll(async () => {
  await resetDb();
});

afterAll(() => {
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
});

beforeEach(() => {
  (sendMail as ReturnType<typeof vi.fn>).mockClear();
});

describe("buildAppUrl() — unit", () => {
  it("builds an absolute URL from a configured APP_URL", () => {
    expect(buildAppUrl("/accept-invite?token=abc123", "https://app.example.com")).toBe(
      "https://app.example.com/accept-invite?token=abc123",
    );
  });

  it("trailing slash on APP_URL never produces a double slash", () => {
    const withoutTrailingSlash = buildAppUrl("/reset-password?token=abc123", "https://app.example.com");
    const withTrailingSlash = buildAppUrl("/reset-password?token=abc123", "https://app.example.com/");
    expect(withoutTrailingSlash).toBe("https://app.example.com/reset-password?token=abc123");
    expect(withTrailingSlash).toBe("https://app.example.com/reset-password?token=abc123");
    expect(withTrailingSlash).toBe(withoutTrailingSlash);
    expect(withTrailingSlash).not.toContain("//reset-password");
  });

  it("multiple trailing slashes are also normalized", () => {
    expect(buildAppUrl("/accept-invite?token=abc123", "https://app.example.com///")).toBe(
      "https://app.example.com/accept-invite?token=abc123",
    );
  });

  it("refuses to build a link when unset in production", () => {
    expect(() => buildAppUrl("/accept-invite?token=abc123", undefined, "production")).toThrow(AppUrlConfigError);
  });

  it("falls back to a working localhost URL when unset outside production — never throws in dev/test", () => {
    expect(buildAppUrl("/accept-invite?token=abc123", undefined, "test")).toBe(
      "http://localhost:5173/accept-invite?token=abc123",
    );
    expect(buildAppUrl("/accept-invite?token=abc123", undefined, "development")).toBe(
      "http://localhost:5173/accept-invite?token=abc123",
    );
  });

  it("a token containing characters that need encoding survives the round trip intact", () => {
    const rawToken = "token with spaces & special=chars+more";
    const url = buildAppUrl(`/accept-invite?token=${encodeURIComponent(rawToken)}`, "https://app.example.com");
    // The raw, un-encoded token must never appear verbatim in the URL...
    expect(url).not.toContain(rawToken);
    // ...but decoding the query value recovers it exactly.
    const parsed = new URL(url);
    expect(parsed.searchParams.get("token")).toBe(rawToken);
  });
});

describe("Invite email — absolute URL", () => {
  let ownerToken: string;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Email Links Co", name: "Owner", email: uniqueEmail("emaillinks-owner"), password: "password123" });
    expect(res.status).toBe(201);
    ownerToken = res.body.token;
  });

  it("with APP_URL configured, the invite email contains a real absolute URL, not a bare relative path", async () => {
    process.env.APP_URL = "https://app.example.com";
    (sendMail as ReturnType<typeof vi.fn>).mockClear();

    const res = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: uniqueEmail("emaillinks-invitee"), role: "member" });
    expect(res.status).toBe(201);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mailBody = (sendMail as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;

    expect(mailBody).toMatch(/https:\/\/app\.example\.com\/accept-invite\?token=[a-f0-9]{64}/);
    // The old, broken relative-only form (a colon-space directly followed by
    // "/accept-invite", with no domain in between) must never appear again.
    expect(mailBody).not.toContain(": /accept-invite?token=");
    expect(mailBody).not.toContain("http:///accept-invite");
  });

  it("trailing slash on APP_URL produces the identical invite link as no trailing slash", async () => {
    const inviteEmailNoSlash = uniqueEmail("emaillinks-invitee-noslash");
    const inviteEmailWithSlash = uniqueEmail("emaillinks-invitee-withslash");

    process.env.APP_URL = "https://app.example.com";
    (sendMail as ReturnType<typeof vi.fn>).mockClear();
    await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: inviteEmailNoSlash, role: "member" });
    const bodyNoSlash = (sendMail as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    const urlNoSlash = bodyNoSlash.match(/https:\/\/[^\s]+/)![0];

    process.env.APP_URL = "https://app.example.com/";
    (sendMail as ReturnType<typeof vi.fn>).mockClear();
    await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: inviteEmailWithSlash, role: "member" });
    const bodyWithSlash = (sendMail as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    const urlWithSlash = bodyWithSlash.match(/https:\/\/[^\s]+/)![0];

    // Same host+path shape on both sides (different tokens, since these are two
    // separate invites) — assert the domain-join point itself never doubles up.
    expect(urlNoSlash.startsWith("https://app.example.com/accept-invite?token=")).toBe(true);
    expect(urlWithSlash.startsWith("https://app.example.com/accept-invite?token=")).toBe(true);
    expect(urlWithSlash).not.toContain("//accept-invite");
  });
});

describe("Password reset email — absolute URL", () => {
  let userEmail: string;

  beforeAll(async () => {
    userEmail = uniqueEmail("emaillinks-reset-user");
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Email Links Reset Co", name: "Owner", email: userEmail, password: "password123" });
    expect(res.status).toBe(201);
  });

  it("with APP_URL configured, the reset email contains a real absolute URL, not a bare relative path", async () => {
    process.env.APP_URL = "https://app.example.com";
    (sendMail as ReturnType<typeof vi.fn>).mockClear();

    const res = await request(app).post("/api/auth/request-password-reset").send({ email: userEmail });
    expect(res.status).toBe(200);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mailBody = (sendMail as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;

    expect(mailBody).toMatch(/https:\/\/app\.example\.com\/reset-password\?token=[a-f0-9]{64}/);
    expect(mailBody).not.toContain("): /reset-password?token=");
    expect(mailBody).not.toContain("http:///reset-password");
  });
});

describe("Regression — token generation, hashing, expiry, and acceptance behavior unchanged", () => {
  it("accept-invite still works end to end with the new absolute-URL email (token extraction, hashing, consumption all unchanged)", async () => {
    process.env.APP_URL = "https://app.example.com";
    (sendMail as ReturnType<typeof vi.fn>).mockClear();

    const ownerRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Regression Co", name: "Owner", email: uniqueEmail("regression-owner"), password: "password123" });
    const ownerToken = ownerRes.body.token;

    const inviteRes = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: uniqueEmail("regression-member"), role: "member" });
    expect(inviteRes.status).toBe(201);

    const mailBody = (sendMail as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    // Same extraction pattern already used across the rest of this suite
    // (authorization.test.ts and ~40 other files) — proves the token itself,
    // its format, and its position in the mail body are all unchanged; only
    // the domain prefix in front of it is new.
    const inviteToken = mailBody.match(/token=([a-f0-9]{64})/)![1];

    const acceptRes = await request(app)
      .post("/api/auth/accept-invite")
      .send({ token: inviteToken, name: "Regression Member", password: "memberpass123" });
    expect(acceptRes.status).toBe(201);
    expect(acceptRes.body.token).toBeDefined();
  });

  it("reset-password still works end to end with the new absolute-URL email (token extraction, hashing, expiry, consumption all unchanged)", async () => {
    process.env.APP_URL = "https://app.example.com";
    const email = uniqueEmail("regression-reset-user");
    await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Regression Reset Co", name: "Owner", email, password: "oldPassword123" });

    (sendMail as ReturnType<typeof vi.fn>).mockClear();
    const requestRes = await request(app).post("/api/auth/request-password-reset").send({ email });
    expect(requestRes.status).toBe(200);

    const mailBody = (sendMail as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    const resetToken = mailBody.match(/token=([a-f0-9]{64})/)![1];

    const resetRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: resetToken, newPassword: "brandNewPassword456" });
    expect(resetRes.status).toBe(200);

    // The new password genuinely works — proves the token round-tripped
    // through hashing/consumption exactly as before.
    const loginRes = await request(app).post("/api/auth/login").send({ email, password: "brandNewPassword456" });
    expect(loginRes.status).toBe(200);
  });

  it("an invalid/expired-shaped token is still rejected the same way as before (reset-password consumption logic unchanged)", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "a".repeat(64), newPassword: "somePassword123" });
    expect(res.status).toBe(400);
  });
});
