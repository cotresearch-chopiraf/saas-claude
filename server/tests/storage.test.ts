import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { files } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { logoFileToDataUri } from "../src/lib/uploads.js";
import { getFile } from "../src/lib/storage/index.js";

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

// A minimal, valid 1x1 PNG, so multer's mimetype/fileFilter and Node's file
// I/O are exercised for real rather than testing storage.ts in isolation.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("storage abstraction: company logo upload proves it end-to-end", () => {
  let token: string;
  let companyId: string;

  beforeAll(async () => {
    await resetDb();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Storage Co", name: "Owner", email: `storage-${Date.now()}@test.com`, password: "password123" });
    token = res.body.token;
    companyId = res.body.company.id;
  });

  it("uploading a logo records a files metadata row and sets company.logoPath", async () => {
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", ONE_PIXEL_PNG, { filename: "test-logo.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(res.body.logoPath).toMatch(/^\/uploads\/logos\//);

    const rows = await db.query.files.findMany({ where: eq(files.entityType, "company_logo") });
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBe(companyId);
    expect(rows[0].mimeType).toBe("image/png");
    expect(rows[0].size).toBe(ONE_PIXEL_PNG.length);
    expect(rows[0].checksum).toBeTruthy();
    expect(rows[0].version).toBe(1);
    expect(rows[0].storageProvider).toBe("local");
  });

  it("the uploaded logo is readable back as a data URI via the existing PDF-rendering helper (backward compatible)", async () => {
    const settings = await request(app).get("/api/company/settings").set("Authorization", `Bearer ${token}`);
    const dataUri = logoFileToDataUri(settings.body.logoPath);
    expect(dataUri).toMatch(/^data:image\/png;base64,/);
  });

  it("a second company cannot read the first company's file metadata by ID (tenant isolation)", async () => {
    const fileRow = (await db.query.files.findFirst({ where: eq(files.entityType, "company_logo") }))!;

    const otherRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Other Storage Co", name: "Owner", email: `storage2-${Date.now()}@test.com`, password: "password123" });
    const otherCompanyId = otherRes.body.company.id;

    const found = await getFile(otherCompanyId, fileRow.id);
    expect(found).toBeUndefined();

    const foundByOwner = await getFile(companyId, fileRow.id);
    expect(foundByOwner?.id).toBe(fileRow.id);
  });

  it("rejects a non-image upload (existing fileFilter still enforced through the new memory-storage config)", async () => {
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", Buffer.from("not an image"), { filename: "evil.exe", contentType: "application/x-msdownload" });
    expect(res.status).toBe(400);
  });
});

// Security fix — read-only audit finding B (stored XSS via SVG logo
// upload). Confirmed in that audit: a real browser executed a <script>/
// onload= payload after direct navigation to an uploaded SVG, and a
// non-image payload merely LABELLED image/svg+xml (or image/png) was
// accepted because the only check was the client-supplied multipart
// Content-Type header. These tests prove both halves of the fix: SVG is
// no longer an accepted MIME type at all, and a mismatched declared-vs-
// actual content type is now caught by a real (dependency-free) magic-
// byte check, not just trusted. Own describe block/company so these
// don't interact with the exact `rows).toHaveLength(1)` assertions above.
describe("logo upload: SVG removed, MIME-spoofing rejected by content check", () => {
  let ownerToken: string;
  let memberToken: string;

  // Minimal buffers carrying only the real magic-byte signature each
  // format begins with — sufficient to exercise
  // bufferMatchesDeclaredImageType() and the full upload path; nothing in
  // this codebase decodes the pixel data itself (ONE_PIXEL_PNG above is a
  // real decodable PNG only because that happened to be convenient as a
  // literal, not because decodability is required anywhere downstream).
  const MINIMAL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const MINIMAL_WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
  const MALICIOUS_SVG = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=1"><script>window.__xss=2</script></svg>',
  );

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "SVG Removal Co", name: "Owner", email: uniqueEmail("svg-removal-owner"), password: "password123" });
    expect(res.status).toBe(201);
    ownerToken = res.body.token;

    const inviteRes = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: uniqueEmail("svg-removal-member"), role: "member" });
    expect(inviteRes.status).toBe(201);
    const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{64})/)![1];
    const acceptRes = await request(app)
      .post("/api/auth/accept-invite")
      .send({ token: inviteToken, name: "Member", password: "memberpass123" });
    expect(acceptRes.status).toBe(201);
    memberToken = acceptRes.body.token;
  });

  it("accepts a valid JPEG", async () => {
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", MINIMAL_JPEG, { filename: "logo.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(200);
    expect(res.body.logoPath).toMatch(/^\/uploads\/logos\//);
  });

  it("accepts a valid WebP", async () => {
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", MINIMAL_WEBP, { filename: "logo.webp", contentType: "image/webp" });
    expect(res.status).toBe(200);
    expect(res.body.logoPath).toMatch(/^\/uploads\/logos\//);
  });

  it("rejects image/svg+xml outright — SVG is no longer an accepted logo MIME type", async () => {
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", MALICIOUS_SVG, { filename: "logo.svg", contentType: "image/svg+xml" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-image (SVG/script) payload falsely labelled image/png — the exact MIME-spoof the audit demonstrated", async () => {
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", MALICIOUS_SVG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("محتوى الملف لا يطابق نوعه المعلن");
  });

  it("rejects a non-image payload falsely labelled image/jpeg", async () => {
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", Buffer.from("plain text, not a jpeg"), { filename: "logo.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-image payload falsely labelled image/webp", async () => {
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", Buffer.from("plain text, not a webp"), { filename: "logo.webp", contentType: "image/webp" });
    expect(res.status).toBe(400);
  });

  it("a real PNG is still accepted after the content check (no false positive on legitimate files)", async () => {
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", onePixelPng, { filename: "real.png", contentType: "image/png" });
    expect(res.status).toBe(200);
  });

  it("a rejected (spoofed) upload never reaches storage — no files row, no company.logoPath change", async () => {
    const before = await request(app).get("/api/company/settings").set("Authorization", `Bearer ${ownerToken}`);
    const beforeLogoPath = before.body.logoPath;
    const beforeCount = (await db.query.files.findMany({ where: eq(files.entityType, "company_logo") })).length;

    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", MALICIOUS_SVG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(400);

    const after = await request(app).get("/api/company/settings").set("Authorization", `Bearer ${ownerToken}`);
    expect(after.body.logoPath).toBe(beforeLogoPath);
    const afterCount = (await db.query.files.findMany({ where: eq(files.entityType, "company_logo") })).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("AUTHORIZATION: a member (non-owner) still cannot upload a logo — RBAC unchanged by this fix", async () => {
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${memberToken}`)
      .attach("logo", MINIMAL_JPEG, { filename: "logo.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(403);
  });

  it("SECURITY REGRESSION: the exact prior PoC (SVG with <script> + onload=) is rejected at upload time — no attacker-controlled SVG is ever created via this route", async () => {
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", MALICIOUS_SVG, { filename: "poc.svg", contentType: "image/svg+xml" });
    expect(res.status).toBe(400);

    // Nothing containing the payload was ever written to storage/DB.
    const rows = await db.query.files.findMany({ where: eq(files.entityType, "company_logo") });
    for (const row of rows) {
      expect(row.mimeType).not.toBe("image/svg+xml");
    }
  });
});
