import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { files } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { logoFileToDataUri } from "../src/lib/uploads.js";
import { getFile } from "../src/lib/storage/index.js";

const app = buildApp();

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
