import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { zatcaSubmissions } from "../src/db/schema.js";
import {
  createEgsUnit,
  getEgsUnit,
  listEgsUnits,
  EgsUnitNotFoundError,
} from "../src/lib/zatca/domain/egsUnits.js";
import { claimNextIcv, getIcvCounter } from "../src/lib/zatca/domain/icv.js";
import { lockAndReadPihPointer, updatePihPointer, peekPihPointer } from "../src/lib/zatca/domain/pih.js";
import { createSubmission, getSubmission, InvalidDocumentReferenceError, CrossTenantReferenceError } from "../src/lib/zatca/domain/submissions.js";
import { GENESIS_PREVIOUS_INVOICE_HASH, computeDocumentHash } from "../src/lib/zatca/hash.js";

// MIDAD ZATCA Slice 2 — persistence layer only. No route calls into this
// module (nothing here is reachable over HTTP), so every test drives the
// domain functions directly, using real registered companies/invoices as
// fixtures. Kept in its own file (not appended to an existing suite) to
// stay under the shared authRateLimit budget — only 2 register calls
// total, both in beforeAll.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let companyA: string;
let tokenA: string;
let companyB: string;
let tokenB: string;

beforeAll(async () => {
  await resetDb();

  const resA = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "ZATCA Domain Co A", name: "Owner A", email: uniqueEmail("zatca-domain-a"), password: "password123" });
  companyA = resA.body.company.id;
  tokenA = resA.body.token;

  const resB = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "ZATCA Domain Co B", name: "Owner B", email: uniqueEmail("zatca-domain-b"), password: "password123" });
  companyB = resB.body.company.id;
  tokenB = resB.body.token;
});

async function createInvoiceFor(token: string): Promise<string> {
  const res = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientName: "ZATCA Test Client", items: [{ description: "Work", amount: 100 }] });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("createEgsUnit / getEgsUnit / listEgsUnits", () => {
  it("creates an EGS unit scoped to the company", async () => {
    const unit = await createEgsUnit(companyA, { name: "Main Office", environment: "simulation" });
    expect(unit.companyId).toBe(companyA);
    expect(unit.status).toBe("not_onboarded");
    expect(unit.csidStatus).toBe("none");
  });

  it("lists only the calling company's EGS units", async () => {
    await createEgsUnit(companyB, { name: "Company B Unit", environment: "simulation" });
    const unitsA = await listEgsUnits(companyA);
    const unitsB = await listEgsUnits(companyB);
    expect(unitsA.every((u) => u.companyId === companyA)).toBe(true);
    expect(unitsB.every((u) => u.companyId === companyB)).toBe(true);
    expect(unitsA.some((u) => u.companyId === companyB)).toBe(false);
  });

  it("TENANT ISOLATION: company A cannot read company B's EGS unit by id", async () => {
    const bUnit = await createEgsUnit(companyB, { name: "B Private Unit", environment: "production" });
    expect(await getEgsUnit(companyA, bUnit.id)).toBeUndefined();
  });

  it("returns the real unit when the owning company requests it", async () => {
    const unit = await createEgsUnit(companyA, { name: "Owned Unit", environment: "simulation" });
    expect((await getEgsUnit(companyA, unit.id))?.id).toBe(unit.id);
  });
});

describe("ICV — atomic claiming", () => {
  it("starts a fresh EGS unit's counter at 1 on first claim", async () => {
    const unit = await createEgsUnit(companyA, { name: "ICV Unit", environment: "simulation" });
    expect(await claimNextIcv(companyA, unit.id)).toBe(1);
  });

  it("increments sequentially on repeated claims", async () => {
    const unit = await createEgsUnit(companyA, { name: "ICV Sequential Unit", environment: "simulation" });
    const values = [];
    for (let i = 0; i < 5; i++) values.push(await claimNextIcv(companyA, unit.id));
    expect(values).toEqual([1, 2, 3, 4, 5]);
  });

  it("CONCURRENCY: two simultaneous claims for the same EGS never collide or lose an update", async () => {
    const unit = await createEgsUnit(companyA, { name: "Concurrent Unit", environment: "simulation" });
    const results = await Promise.all(Array.from({ length: 10 }, () => claimNextIcv(companyA, unit.id)));
    const unique = new Set(results);
    expect(unique.size).toBe(10);
    expect([...unique].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("maintains independent counters per EGS unit within the same company", async () => {
    const unit1 = await createEgsUnit(companyA, { name: "Multi EGS 1", environment: "simulation" });
    const unit2 = await createEgsUnit(companyA, { name: "Multi EGS 2", environment: "simulation" });
    await claimNextIcv(companyA, unit1.id);
    await claimNextIcv(companyA, unit1.id);
    expect(await claimNextIcv(companyA, unit2.id)).toBe(1);
  });

  it("TENANT ISOLATION: company A cannot claim/increment company B's ICV counter", async () => {
    const bUnit = await createEgsUnit(companyB, { name: "B ICV Unit", environment: "simulation" });
    await expect(claimNextIcv(companyA, bUnit.id)).rejects.toThrow(EgsUnitNotFoundError);
  });

  it("throws EgsUnitNotFoundError for a nonexistent EGS unit id", async () => {
    await expect(claimNextIcv(companyA, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(EgsUnitNotFoundError);
  });

  it("never touches companies.next_invoice_number", async () => {
    const before = await db.query.companies.findFirst({ where: (c, { eq }) => eq(c.id, companyA), columns: { nextInvoiceNumber: true } });
    const unit = await createEgsUnit(companyA, { name: "Isolation Check Unit", environment: "simulation" });
    await claimNextIcv(companyA, unit.id);
    await claimNextIcv(companyA, unit.id);
    const after = await db.query.companies.findFirst({ where: (c, { eq }) => eq(c.id, companyA), columns: { nextInvoiceNumber: true } });
    expect(after?.nextInvoiceNumber).toBe(before?.nextInvoiceNumber);
  });

  it("getIcvCounter reflects the claimed value and is itself tenant-scoped", async () => {
    const unit = await createEgsUnit(companyA, { name: "Get Counter Unit", environment: "simulation" });
    await claimNextIcv(companyA, unit.id);
    await claimNextIcv(companyA, unit.id);
    expect((await getIcvCounter(companyA, unit.id))?.value).toBe(2);
    expect(await getIcvCounter(companyB, unit.id)).toBeUndefined();
  });
});

describe("PIH — chain pointer", () => {
  it("returns the genesis hash for a fresh EGS unit with no prior document", async () => {
    const unit = await createEgsUnit(companyA, { name: "Genesis Unit", environment: "simulation" });
    expect(await peekPihPointer(companyA, unit.id)).toBe(GENESIS_PREVIOUS_INVOICE_HASH);
  });

  it("read-under-lock and update work transactionally, and the next read reflects the update", async () => {
    const unit = await createEgsUnit(companyA, { name: "PIH Update Unit", environment: "simulation" });
    const newHash = computeDocumentHash("first-document-xml");

    await db.transaction(async (tx) => {
      const previous = await lockAndReadPihPointer(tx, companyA, unit.id);
      expect(previous).toBe(GENESIS_PREVIOUS_INVOICE_HASH);
      await updatePihPointer(tx, companyA, unit.id, newHash);
    });

    expect(await peekPihPointer(companyA, unit.id)).toBe(newHash);
  });

  it("chains correctly across multiple sequential documents", async () => {
    const unit = await createEgsUnit(companyA, { name: "PIH Chain Unit", environment: "simulation" });
    const hash1 = computeDocumentHash("doc-1");
    const hash2 = computeDocumentHash("doc-2");

    await db.transaction(async (tx) => {
      const previous = await lockAndReadPihPointer(tx, companyA, unit.id);
      expect(previous).toBe(GENESIS_PREVIOUS_INVOICE_HASH);
      await updatePihPointer(tx, companyA, unit.id, hash1);
    });
    await db.transaction(async (tx) => {
      const previous = await lockAndReadPihPointer(tx, companyA, unit.id);
      expect(previous).toBe(hash1);
      await updatePihPointer(tx, companyA, unit.id, hash2);
    });

    expect(await peekPihPointer(companyA, unit.id)).toBe(hash2);
  });

  it("TENANT ISOLATION: company A cannot read or update company B's PIH pointer", async () => {
    const bUnit = await createEgsUnit(companyB, { name: "B PIH Unit", environment: "simulation" });
    await expect(peekPihPointer(companyA, bUnit.id)).rejects.toThrow(EgsUnitNotFoundError);
    await expect(
      db.transaction(async (tx) => {
        await lockAndReadPihPointer(tx, companyA, bUnit.id);
      }),
    ).rejects.toThrow(EgsUnitNotFoundError);
  });

  it("CONCURRENCY: simultaneous lock-and-update operations for the same EGS serialize correctly (no lost update)", async () => {
    const unit = await createEgsUnit(companyA, { name: "PIH Concurrency Unit", environment: "simulation" });
    const hashes = Array.from({ length: 5 }, (_, i) => computeDocumentHash(`concurrent-doc-${i}`));

    await Promise.all(
      hashes.map((hash) =>
        db.transaction(async (tx) => {
          await lockAndReadPihPointer(tx, companyA, unit.id);
          await updatePihPointer(tx, companyA, unit.id, hash);
        }),
      ),
    );

    expect(hashes).toContain(await peekPihPointer(companyA, unit.id));
  });
});

describe("Submissions — exactly-one-document-reference invariant", () => {
  it("creates a submission referencing exactly one invoice", async () => {
    const unit = await createEgsUnit(companyA, { name: "Submission Unit", environment: "simulation" });
    const invoiceId = await createInvoiceFor(tokenA);
    const submission = await createSubmission(companyA, {
      egsUnitId: unit.id,
      invoiceId,
      documentTypeCode: "388",
      subtype: "standard",
      zatcaUuid: crypto.randomUUID(),
      icv: await claimNextIcv(companyA, unit.id),
      pih: GENESIS_PREVIOUS_INVOICE_HASH,
      documentHash: computeDocumentHash("xml-content"),
      environment: "simulation",
    });
    expect(submission.invoiceId).toBe(invoiceId);
    expect(submission.creditNoteId).toBeNull();
    expect(submission.debitNoteId).toBeNull();
    expect(submission.state).toBe("not_submitted");
  });

  it("rejects a submission with zero document references (application-level check)", async () => {
    const unit = await createEgsUnit(companyA, { name: "No Ref Unit", environment: "simulation" });
    await expect(
      createSubmission(companyA, {
        egsUnitId: unit.id,
        documentTypeCode: "388",
        subtype: "standard",
        zatcaUuid: crypto.randomUUID(),
        icv: 1,
        pih: GENESIS_PREVIOUS_INVOICE_HASH,
        documentHash: computeDocumentHash("x"),
        environment: "simulation",
      }),
    ).rejects.toThrow(InvalidDocumentReferenceError);
  });

  it("rejects a submission with two document references (application-level check)", async () => {
    const unit = await createEgsUnit(companyA, { name: "Two Ref Unit", environment: "simulation" });
    const invoiceId = await createInvoiceFor(tokenA);
    await expect(
      createSubmission(companyA, {
        egsUnitId: unit.id,
        invoiceId,
        creditNoteId: crypto.randomUUID(),
        documentTypeCode: "388",
        subtype: "standard",
        zatcaUuid: crypto.randomUUID(),
        icv: 1,
        pih: GENESIS_PREVIOUS_INVOICE_HASH,
        documentHash: computeDocumentHash("x"),
        environment: "simulation",
      }),
    ).rejects.toThrow(InvalidDocumentReferenceError);
  });

  it("DATABASE INVARIANT: the CHECK constraint itself rejects a multi-reference row bypassing the application layer", async () => {
    const unit = await createEgsUnit(companyA, { name: "Raw Insert Unit", environment: "simulation" });
    const invoiceId = await createInvoiceFor(tokenA);
    let caught: unknown;
    try {
      await db.insert(zatcaSubmissions).values({
        companyId: companyA,
        egsUnitId: unit.id,
        invoiceId,
        creditNoteId: crypto.randomUUID(), // bypasses createSubmission's own check entirely
        documentTypeCode: "388",
        subtype: "standard",
        zatcaUuid: crypto.randomUUID(),
        icv: 1,
        pih: GENESIS_PREVIOUS_INVOICE_HASH,
        documentHash: computeDocumentHash("x"),
        environment: "simulation",
      });
    } catch (err) {
      caught = err;
    }
    // drizzle-orm wraps the raw pg driver error in a DrizzleQueryError whose
    // own .message is the failed SQL text; the underlying Postgres error
    // (with the constraint name) is preserved as .cause.
    expect(caught).toBeInstanceOf(Error);
    const pgError = (caught as { cause?: unknown }).cause;
    expect(pgError).toBeInstanceOf(Error);
    expect((pgError as Error).message).toMatch(/zatca_submissions_exactly_one_document_reference/);
  });

  it("CROSS-TENANT: rejects creating a submission for company A that references company B's invoice", async () => {
    const unit = await createEgsUnit(companyA, { name: "Cross Tenant Unit", environment: "simulation" });
    const bInvoiceId = await createInvoiceFor(tokenB);

    await expect(
      createSubmission(companyA, {
        egsUnitId: unit.id,
        invoiceId: bInvoiceId,
        documentTypeCode: "388",
        subtype: "standard",
        zatcaUuid: crypto.randomUUID(),
        icv: 1,
        pih: GENESIS_PREVIOUS_INVOICE_HASH,
        documentHash: computeDocumentHash("x"),
        environment: "simulation",
      }),
    ).rejects.toThrow(CrossTenantReferenceError);
  });

  it("CROSS-TENANT: rejects creating a submission whose EGS unit belongs to a different company than the caller", async () => {
    const bUnit = await createEgsUnit(companyB, { name: "B EGS For A Attempt", environment: "simulation" });
    const invoiceId = await createInvoiceFor(tokenA);
    await expect(
      createSubmission(companyA, {
        egsUnitId: bUnit.id,
        invoiceId,
        documentTypeCode: "388",
        subtype: "standard",
        zatcaUuid: crypto.randomUUID(),
        icv: 1,
        pih: GENESIS_PREVIOUS_INVOICE_HASH,
        documentHash: computeDocumentHash("x"),
        environment: "simulation",
      }),
    ).rejects.toThrow(EgsUnitNotFoundError);
  });

  it("TENANT ISOLATION: company A cannot read company B's submission via getSubmission", async () => {
    const unit = await createEgsUnit(companyB, { name: "B Submission Unit", environment: "simulation" });
    const invoiceId = await createInvoiceFor(tokenB);
    const submission = await createSubmission(companyB, {
      egsUnitId: unit.id,
      invoiceId,
      documentTypeCode: "388",
      subtype: "standard",
      zatcaUuid: crypto.randomUUID(),
      icv: 1,
      pih: GENESIS_PREVIOUS_INVOICE_HASH,
      documentHash: computeDocumentHash("x"),
      environment: "simulation",
    });

    expect(await getSubmission(companyA, submission.id)).toBeUndefined();
    expect((await getSubmission(companyB, submission.id))?.id).toBe(submission.id);
  });
});
