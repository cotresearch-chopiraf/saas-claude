import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { files } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { sanitizeExtension } from "../src/lib/storage/types.js";
import { logoFileToDataUri } from "../src/lib/uploads.js";
import { buildDocumentHtml, type DocumentData } from "../src/lib/documentHtml.js";

// Final Launch Gate Audit, Phase 2A — a client-supplied original filename
// like `evil.png" onerror="alert(1)` previously survived, untouched,
// through path.extname() -> the persisted storageKey -> company.logoPath
// -> logoFileToDataUri()'s derived MIME string -> an unescaped
// <img src="..."> attribute in the HTML this server renders to PDF via a
// real headless Chromium (lib/pdf.ts). That HTML-attribute breakout was
// reproduced and confirmed exploitable before this fix (see the audit
// report) — these tests prove the fix closes it at both the source
// (storage-key extension is sanitized) and the sink (the HTML attribute
// is escaped regardless), without breaking a real, legitimate logo.

const app = buildApp();

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

describe("sanitizeExtension() (pure)", () => {
  it("keeps a normal, short alphanumeric extension unchanged", () => {
    expect(sanitizeExtension(".png")).toBe(".png");
    expect(sanitizeExtension(".jpeg")).toBe(".jpeg");
    expect(sanitizeExtension(".pdf")).toBe(".pdf");
  });

  it("strips an extension containing an HTML-attribute-breaking quote", () => {
    expect(sanitizeExtension('.png" onerror="alert(1)')).toBe("");
  });

  it("strips an extension containing other unsafe characters (<, >, /, whitespace, null)", () => {
    expect(sanitizeExtension(".png<script>")).toBe("");
    expect(sanitizeExtension(".png/../../etc")).toBe("");
    expect(sanitizeExtension(".png ")).toBe("");
    expect(sanitizeExtension(".png\0")).toBe("");
  });

  it("strips an unreasonably long extension", () => {
    expect(sanitizeExtension("." + "a".repeat(50))).toBe("");
  });

  it("strips an empty/malformed extension", () => {
    expect(sanitizeExtension("")).toBe("");
    expect(sanitizeExtension(".")).toBe("");
  });
});

describe("logo upload with a malicious filename never persists an unsafe extension", () => {
  let ownerToken: string;

  beforeAll(async () => {
    await resetDb();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "PDF Injection Co", name: "Owner", email: uniqueEmail("pdfinj-owner"), password: "password123" });
    expect(res.status).toBe(201);
    ownerToken = res.body.token;
  });

  it("an attribute-breakout filename is stored with the malicious extension stripped, not preserved", async () => {
    const uploadRes = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", ONE_PIXEL_PNG, { filename: 'evil.png" onerror="alert(1).png', contentType: "image/png" });
    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.logoPath).toMatch(/^\/uploads\/logos\//);

    const fileRow = await db.query.files.findFirst({ where: eq(files.entityType, "company_logo") });
    expect(fileRow).toBeTruthy();
    // Node's path.extname() takes from the LAST "." — here that's the
    // trailing, legitimate ".png", so this particular payload shape is
    // naturally inert; the real proof is the next test, which puts the
    // injection payload directly where extname() would return it.
    expect(fileRow!.storageKey).not.toContain('"');
    expect(fileRow!.storageKey).not.toContain("<");

    const dataUri = logoFileToDataUri(uploadRes.body.logoPath);
    expect(dataUri).toBeTruthy();
    expect(dataUri).not.toContain('"');
  });

  it("a filename whose only \".\" precedes the injection payload is stored with NO extension, never the raw payload", async () => {
    // This is the exact shape that broke the HTML attribute before this
    // fix: a single "." followed by attacker-controlled content and no
    // further "." — path.extname() returns everything from that "." to
    // the end of the string.
    const maliciousFilename = 'evil.png" onerror="alert(1)';
    const uploadRes = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", ONE_PIXEL_PNG, { filename: maliciousFilename, contentType: "image/png" });
    expect(uploadRes.status).toBe(200);

    const fileRow = await db.query.files.findFirst({
      where: eq(files.entityType, "company_logo"),
      orderBy: (f, { desc }) => [desc(f.uploadedAt)],
    });
    expect(fileRow).toBeTruthy();
    // sanitizeExtension() rejects the whole malformed extension outright
    // (it contains a quote), so the stored key carries NO extension at
    // all — never the attacker's payload in any form.
    expect(fileRow!.storageKey).not.toContain('"');
    expect(fileRow!.storageKey).not.toContain("onerror");
    expect(fileRow!.storageKey).toMatch(/^logos\/[0-9a-f-]{36}$/);

    // logoFileToDataUri derives its MIME string from this same (now safe)
    // on-disk extension — confirm the full downstream value is clean too.
    const dataUri = logoFileToDataUri(uploadRes.body.logoPath);
    expect(dataUri).toBeTruthy();
    expect(dataUri).not.toContain('"');
    expect(dataUri).not.toContain("onerror");
  });

  it("legitimate logo upload and PDF-template rendering still work end-to-end", async () => {
    const uploadRes = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", ONE_PIXEL_PNG, { filename: "company-logo.png", contentType: "image/png" });
    expect(uploadRes.status).toBe(200);

    const dataUri = logoFileToDataUri(uploadRes.body.logoPath);
    expect(dataUri).toMatch(/^data:image\/png;base64,/);

    const html = buildDocumentHtml(baseDocument({ logoDataUri: dataUri }));
    expect(html).toContain(`<img class="logo" src="${dataUri}" />`);
  });
});

function baseDocument(companyOverrides: Partial<DocumentData["company"]> = {}): DocumentData {
  return {
    kind: "invoice",
    language: "ar",
    number: "INV-1",
    date: "2026-01-01",
    company: {
      name: "شركة الاختبار",
      logoDataUri: null,
      address: null,
      taxId: null,
      phone: null,
      ...companyOverrides,
    },
    client: { name: "عميل", address: null, taxId: null },
    items: [{ description: "بند", amount: 100 }],
    taxRatePercent: 15,
  };
}

describe("buildDocumentHtml(): the logo <img> attribute is safely constructed regardless of source", () => {
  it("a would-be attribute-breaking logoDataUri is escaped, never left able to close the src attribute early", () => {
    const malicious = 'data:image/png" onerror="alert(1);base64,AAAA';
    const html = buildDocumentHtml(baseDocument({ logoDataUri: malicious }));

    // The dangerous literal sequence must never appear unescaped in the
    // output — only its HTML-escaped form.
    expect(html).not.toContain('src="data:image/png" onerror="alert(1);base64,AAAA"');
    expect(html).toContain("&quot;");

    // And the resulting <img> tag must still be exactly one well-formed
    // element with exactly the two attributes this template ever writes
    // for it (class, src) — the escaped payload (harmless text, including
    // the literal string "onerror=") lives entirely inside the single src
    // attribute's value; the tag never gains a third, live attribute.
    const imgTagMatch = html.match(/<img[^>]*\/>/);
    expect(imgTagMatch).toBeTruthy();
    const imgTag = imgTagMatch![0];
    expect(imgTag).toMatch(/^<img class="logo" src="[^"]*" \/>$/);
  });

  it("a null logoDataUri renders no <img> tag at all (unchanged existing behavior)", () => {
    const html = buildDocumentHtml(baseDocument({ logoDataUri: null }));
    expect(html).not.toContain("<img");
  });
});
