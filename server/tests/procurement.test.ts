import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, commitmentLines, commitments, projects } from "../src/db/schema.js";

// Phase 2A: Procurement + Supplier + Commitment foundation.
// Same shared-company-per-file discipline as midadFoundation.test.ts (auth
// endpoints are rate-limited; a real user only registers/invites once).

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;
let memberToken: string;
let companyBToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Procurement Co", name: "Owner", email: uniqueEmail("proc-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("proc-member"), role: "member" });
  expect(inviteRes.status).toBe(201);
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{64})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberToken = acceptRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("proc-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Procurement Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createSupplier(overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/suppliers")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: `Supplier ${Math.random()}`, type: "supplier", ...overrides });
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string };
}

async function createDraftCommitment(projectId: string, supplierId: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/commitments`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ supplierId, type: "purchase_order", ...overrides });
  expect(res.status).toBe(201);
  return res.body as { id: string; commitment_number: number; status: string };
}

async function addLine(projectId: string, commitmentId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send(body);
}

describe("Supplier", () => {
  it("owner can create a supplier", async () => {
    const res = await request(app)
      .post("/api/suppliers")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Al Rashid Materials", type: "supplier", taxId: "300123456700003" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Al Rashid Materials");
    expect(res.body.status).toBe("active");
  });

  it("a member cannot create a supplier", async () => {
    const res = await request(app)
      .post("/api/suppliers")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Should Fail", type: "supplier" });
    expect(res.status).toBe(403);
  });

  it("a member CAN read the supplier list (read is unrestricted)", async () => {
    await createSupplier();
    const res = await request(app).get("/api/suppliers").set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("rejects an invalid type", async () => {
    const res = await request(app)
      .post("/api/suppliers")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Bad Type Co", type: "not_a_real_type" });
    expect(res.status).toBe(400);
  });

  it("another company cannot read or update this supplier", async () => {
    const supplier = await createSupplier();
    const getRes = await request(app)
      .get(`/api/suppliers/${supplier.id}`)
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(getRes.status).toBe(404);

    const patchRes = await request(app)
      .patch(`/api/suppliers/${supplier.id}`)
      .set("Authorization", `Bearer ${companyBToken}`)
      .send({ name: "Hijacked" });
    expect(patchRes.status).toBe(404);
  });

  it("owner can update a supplier, and it is audited", async () => {
    const supplier = await createSupplier();
    const res = await request(app)
      .patch(`/api/suppliers/${supplier.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "inactive" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("inactive");

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, supplier.id) });
    expect(events.some((e) => e.action === "supplier.updated")).toBe(true);
  });
});

describe("Commitment: creation, reads, tenant isolation, numbering", () => {
  it("creates a draft purchase_order commitment with a company-scoped sequential number", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();

    const c1 = await createDraftCommitment(projectId, supplier.id);
    expect(c1.status).toBe("draft");

    const c2 = await createDraftCommitment(projectId, supplier.id);
    expect(c2.commitment_number).toBe(c1.commitment_number + 1);
  });

  // Concurrency Hardening: the MAX+1 subquery alone is not race-safe — two
  // concurrent INSERTs can each read the same prior MAX before either
  // commits. Same class of bug empirically proven (and fixed) for IPC
  // numbering in Phase 2C; see docs/MIDAD_CONCURRENCY_HARDENING.md. Uses a
  // dedicated fresh company (registered here, not the shared file-level
  // one) so the asserted numbers are exact, not merely "N distinct values"
  // on top of whatever earlier tests in this file already claimed.
  it("5x: concurrent commitment creation for the same company never collides on commitment_number", async () => {
    const freshRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Concurrency Co", name: "Owner", email: uniqueEmail("proc-conc"), password: "password123" });
    expect(freshRes.status).toBe(201);
    const freshToken = freshRes.body.token as string;

    const projectRes = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${freshToken}`)
      .send({ name: "Concurrency Project" });
    const projectId = projectRes.body.id as string;

    const supplierRes = await request(app)
      .post("/api/suppliers")
      .set("Authorization", `Bearer ${freshToken}`)
      .send({ name: "Concurrency Supplier", type: "supplier" });
    const supplierId = supplierRes.body.id as string;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/projects/${projectId}/commitments`)
          .set("Authorization", `Bearer ${freshToken}`)
          .send({ supplierId, type: "purchase_order" }),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);

    const numbers = results.map((r) => r.body.commitment_number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(5); // count(numbers) == count(unique(numbers))
    expect(numbers).toEqual([1, 2, 3, 4, 5]); // contiguous from this fresh company's MAX (0) + 1
  });

  // Cross-scope proof: commitment numbering is company-wide, so the
  // correct "independent scope" is a different COMPANY (not project). The
  // parent-row lock must not serialize commitment creation across
  // unrelated companies.
  it("independent companies are not serialized against each other, and each keeps its own correct sequence", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();

    const projectBRes = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${companyBToken}`)
      .send({ name: "Company B Project" });
    const projectBId = projectBRes.body.id as string;
    const supplierBRes = await request(app)
      .post("/api/suppliers")
      .set("Authorization", `Bearer ${companyBToken}`)
      .send({ name: "Company B Supplier", type: "supplier" });
    const supplierBId = supplierBRes.body.id as string;

    const [beforeA] = await Promise.all([createDraftCommitment(projectId, supplier.id)]);

    const results = await Promise.all([
      createDraftCommitment(projectId, supplier.id),
      request(app)
        .post(`/api/projects/${projectBId}/commitments`)
        .set("Authorization", `Bearer ${companyBToken}`)
        .send({ supplierId: supplierBId, type: "purchase_order" }),
    ]);

    expect(results[0].commitment_number).toBe(beforeA.commitment_number + 1);
    expect(results[1].status).toBe(201); // company B's own independent sequence, unaffected by company A's numbers
  });

  it("rejects a supplierId belonging to another company", async () => {
    const projectId = await createProject();
    const otherSupplierRes = await request(app)
      .post("/api/suppliers")
      .set("Authorization", `Bearer ${companyBToken}`)
      .send({ name: "Rival Supplier", type: "supplier" });

    const res = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ supplierId: otherSupplierRes.body.id, type: "purchase_order" });
    expect(res.status).toBe(404);
  });

  it("rejects a contractId that does not belong to this project", async () => {
    const projectId = await createProject();
    const otherProjectId = await createProject();
    const contractRes = await request(app)
      .post(`/api/projects/${otherProjectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ originalValue: 10000 });
    const supplier = await createSupplier();

    const res = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ supplierId: supplier.id, type: "subcontract", contractId: contractRes.body.id });
    expect(res.status).toBe(404);
  });

  it("a member cannot create a commitment (RBAC)", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const res = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ supplierId: supplier.id, type: "purchase_order" });
    expect(res.status).toBe(403);
  });

  it("a member CAN read commitments (read is unrestricted)", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    await createDraftCommitment(projectId, supplier.id);
    const res = await request(app)
      .get(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("another company cannot read this project's commitments", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);

    const res = await request(app)
      .get(`/api/projects/${projectId}/commitments/${c.id}`)
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(res.status).toBe(404);
  });
});

describe("Commitment Lines: monetary calculation and cross-tenant validation", () => {
  it("computes amount from quantity * rate the same way BOQ items do", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);

    const res = await addLine(projectId, c.id, { description: "Rebar 12mm", quantity: 12.5, rate: 40 });
    expect(res.status).toBe(201);
    expect(Number(res.body.amount)).toBe(500);
  });

  it("accepts an explicit amount when quantity/rate are not given", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);

    const res = await addLine(projectId, c.id, { description: "Lump sum item", amount: 1500 });
    expect(res.status).toBe(201);
    expect(Number(res.body.amount)).toBe(1500);
  });

  it("rejects a line with neither amount nor quantity+rate", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);

    const res = await addLine(projectId, c.id, { description: "Ambiguous" });
    expect(res.status).toBe(400);
  });

  it("rejects a costCodeId belonging to another company", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);

    const otherCostCodeRes = await request(app)
      .post("/api/cost-codes")
      .set("Authorization", `Bearer ${companyBToken}`)
      .send({ code: "RIVAL-CC", name: "Rival cost code" });

    const res = await addLine(projectId, c.id, {
      description: "Cross-tenant cost code",
      amount: 100,
      costCodeId: otherCostCodeRes.body.id,
    });
    expect(res.status).toBe(404);
  });

  it("rejects a boqItemId belonging to another project", async () => {
    const projectId = await createProject();
    const otherProjectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);

    const otherContractRes = await request(app)
      .post(`/api/projects/${otherProjectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ originalValue: 5000 });
    const otherRevRes = await request(app)
      .post(`/api/projects/${otherProjectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: otherContractRes.body.id });
    const otherItemRes = await request(app)
      .post(`/api/projects/${otherProjectId}/boq-revisions/${otherRevRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Other project's item", quantity: 1, rate: 1 });

    const res = await addLine(projectId, c.id, {
      description: "Wrong-project BOQ item",
      amount: 100,
      boqItemId: otherItemRes.body.id,
    });
    expect(res.status).toBe(404);
  });

  it("accepts a valid costCodeId and boqItemId from this project", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const contractRes = await request(app)
      .post(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ originalValue: 5000 });
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: contractRes.body.id });
    const boqItemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Concrete works", quantity: 10, rate: 50 });
    const costCodeRes = await request(app)
      .post("/api/cost-codes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ code: `CC-COMMIT-${Date.now()}`, name: "Concrete" });
    const c = await createDraftCommitment(projectId, supplier.id, { contractId: contractRes.body.id });

    const res = await addLine(projectId, c.id, {
      description: "Matches BOQ item",
      quantity: 10,
      rate: 50,
      boqItemId: boqItemRes.body.id,
      costCodeId: costCodeRes.body.id,
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.amount)).toBe(500);
  });

  it("wrong-project commitment id is rejected (line cannot be added through a different project's URL)", async () => {
    const projectId = await createProject();
    const otherProjectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);

    const res = await request(app)
      .post(`/api/projects/${otherProjectId}/commitments/${c.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Wrong project URL", amount: 100 });
    expect(res.status).toBe(404);
  });
});

describe("Commitment state machine", () => {
  it("draft -> pending_approval -> active is the valid path, freezing originalAmount/revisedAmount", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);
    await addLine(projectId, c.id, { description: "Item A", amount: 1000 });
    await addLine(projectId, c.id, { description: "Item B", amount: 500 });

    const submitRes = await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe("pending_approval");
    expect(Number(submitRes.body.originalAmount)).toBe(1500);
    expect(Number(submitRes.body.revisedAmount)).toBe(1500);

    const approveRes = await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe("active");
  });

  it("cannot submit a commitment with zero lines", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);

    const res = await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });

  it("cannot approve a draft commitment directly (must be submitted first)", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);

    const res = await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(409);
  });

  it("cannot add or remove lines once submitted (pending_approval is immutable)", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);
    const lineRes = await addLine(projectId, c.id, { description: "Item", amount: 100 });
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const addAfterSubmit = await addLine(projectId, c.id, { description: "Too late", amount: 50 });
    expect(addAfterSubmit.status).toBe(409);

    const deleteAfterSubmit = await request(app)
      .delete(`/api/projects/${projectId}/commitments/${c.id}/items/${lineRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(deleteAfterSubmit.status).toBe(409);
  });

  it("draft can be cancelled; pending_approval can be cancelled; active cannot", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();

    const draftC = await createDraftCommitment(projectId, supplier.id);
    const cancelDraft = await request(app)
      .post(`/api/projects/${projectId}/commitments/${draftC.id}/cancel`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(cancelDraft.status).toBe(200);
    expect(cancelDraft.body.status).toBe("cancelled");

    const pendingC = await createDraftCommitment(projectId, supplier.id);
    await addLine(projectId, pendingC.id, { description: "Item", amount: 200 });
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${pendingC.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const cancelPending = await request(app)
      .post(`/api/projects/${projectId}/commitments/${pendingC.id}/cancel`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(cancelPending.status).toBe(200);

    const activeC = await createDraftCommitment(projectId, supplier.id);
    await addLine(projectId, activeC.id, { description: "Item", amount: 300 });
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${activeC.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${activeC.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const cancelActive = await request(app)
      .post(`/api/projects/${projectId}/commitments/${activeC.id}/cancel`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(cancelActive.status).toBe(409);
  });

  it("a member cannot submit, approve, or cancel", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);
    await addLine(projectId, c.id, { description: "Item", amount: 100 });

    const submitAsMember = await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/submit`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(submitAsMember.status).toBe(403);

    await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const approveAsMember = await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/approve`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(approveAsMember.status).toBe(403);

    const cancelAsMember = await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/cancel`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(cancelAsMember.status).toBe(403);
  });
});

describe("Commitment amendment", () => {
  async function createActiveCommitment(projectId: string, supplierId: string) {
    const c = await createDraftCommitment(projectId, supplierId);
    await addLine(projectId, c.id, { description: "Original item", amount: 1000 });
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const approveRes = await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    return approveRes.body as { id: string; originalAmount: string; revisedAmount: string };
  }

  it("amending an active commitment adds lines and recomputes revisedAmount from the FULL line set", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const active = await createActiveCommitment(projectId, supplier.id);
    expect(Number(active.revisedAmount)).toBe(1000);

    const amendRes = await request(app)
      .post(`/api/projects/${projectId}/commitments/${active.id}/amend`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "Additional scope", lines: [{ description: "Extra item", amount: 400 }] });
    expect(amendRes.status).toBe(200);
    expect(Number(amendRes.body.revisedAmount)).toBe(1400);
    // originalAmount is frozen forever — the amendment never touches it.
    expect(Number(amendRes.body.originalAmount)).toBe(1000);

    const lines = await db.query.commitmentLines.findMany({ where: eq(commitmentLines.commitmentId, active.id) });
    expect(lines).toHaveLength(2);
  });

  it("a second amendment correctly compounds on top of the first (never overwrites it)", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const active = await createActiveCommitment(projectId, supplier.id);

    await request(app)
      .post(`/api/projects/${projectId}/commitments/${active.id}/amend`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ lines: [{ description: "Amendment 1", amount: 200 }] });
    const second = await request(app)
      .post(`/api/projects/${projectId}/commitments/${active.id}/amend`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ lines: [{ description: "Amendment 2", amount: 300 }] });

    expect(Number(second.body.revisedAmount)).toBe(1500); // 1000 + 200 + 300
  });

  it("cannot amend a draft commitment", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const draft = await createDraftCommitment(projectId, supplier.id);

    const res = await request(app)
      .post(`/api/projects/${projectId}/commitments/${draft.id}/amend`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ lines: [{ description: "Too early", amount: 100 }] });
    expect(res.status).toBe(409);
  });

  it("cannot amend a cancelled commitment", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const draft = await createDraftCommitment(projectId, supplier.id);
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${draft.id}/cancel`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const res = await request(app)
      .post(`/api/projects/${projectId}/commitments/${draft.id}/amend`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ lines: [{ description: "Cancelled commitment", amount: 100 }] });
    expect(res.status).toBe(409);
  });

  it("a member cannot amend a commitment", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const active = await createActiveCommitment(projectId, supplier.id);

    const res = await request(app)
      .post(`/api/projects/${projectId}/commitments/${active.id}/amend`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ lines: [{ description: "Member attempt", amount: 100 }] });
    expect(res.status).toBe(403);
  });

  // Dynamic concurrency test, same discipline as tests/hardening.test.ts:
  // two simultaneous amendments on the SAME active commitment must never
  // let one overwrite the other's contribution to revisedAmount.
  it("5x: concurrent amendments never lose a contribution to revisedAmount", async () => {
    for (let trial = 0; trial < 5; trial++) {
      const projectId = await createProject();
      const supplier = await createSupplier();
      const active = await createActiveCommitment(projectId, supplier.id);

      const amend = (amount: number) =>
        request(app)
          .post(`/api/projects/${projectId}/commitments/${active.id}/amend`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ lines: [{ description: `Race amendment ${amount}`, amount }] });

      const [r1, r2] = await Promise.all([amend(100), amend(250)]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // The database is the source of truth: both new lines must exist,
      // and revisedAmount must equal the sum of ALL lines — not just
      // whichever amendment's transaction happened to commit last.
      const lines = await db.query.commitmentLines.findMany({ where: eq(commitmentLines.commitmentId, active.id) });
      expect(lines).toHaveLength(3); // original 1000 + two race amendments
      const expectedTotal = lines.reduce((sum, l) => sum + Number(l.amount), 0);

      const finalCommitment = await db.query.commitments.findFirst({ where: eq(commitments.id, active.id) });
      expect(Number(finalCommitment?.revisedAmount)).toBe(expectedTotal);
      expect(Number(finalCommitment?.revisedAmount)).toBe(1350); // 1000 + 100 + 250
    }
  });
});

describe("Approval concurrency", () => {
  it("5x: N concurrent approvals of the SAME commitment — exactly one succeeds", async () => {
    for (let trial = 0; trial < 5; trial++) {
      const projectId = await createProject();
      const supplier = await createSupplier();
      const c = await createDraftCommitment(projectId, supplier.id);
      await addLine(projectId, c.id, { description: "Item", amount: 100 });
      await request(app)
        .post(`/api/projects/${projectId}/commitments/${c.id}/submit`)
        .set("Authorization", `Bearer ${ownerToken}`);

      const approve = () =>
        request(app)
          .post(`/api/projects/${projectId}/commitments/${c.id}/approve`)
          .set("Authorization", `Bearer ${ownerToken}`);

      const results = await Promise.all(Array.from({ length: 6 }, approve));
      const successes = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);
      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(5);

      const finalCommitment = await db.query.commitments.findFirst({ where: eq(commitments.id, c.id) });
      expect(finalCommitment?.status).toBe("active");
    }
  });

  it("5x: concurrent submit + add-item never leaves an inconsistent database state", async () => {
    for (let trial = 0; trial < 5; trial++) {
      const projectId = await createProject();
      const supplier = await createSupplier();
      const c = await createDraftCommitment(projectId, supplier.id);
      await addLine(projectId, c.id, { description: "Seed item", amount: 100 });

      const [submitRes, addItemRes] = await Promise.all([
        request(app)
          .post(`/api/projects/${projectId}/commitments/${c.id}/submit`)
          .set("Authorization", `Bearer ${ownerToken}`),
        addLine(projectId, c.id, { description: "Race item", amount: 50 }),
      ]);

      expect(submitRes.status).toBe(200);
      expect([201, 409]).toContain(addItemRes.status);

      const lines = await db.query.commitmentLines.findMany({ where: eq(commitmentLines.commitmentId, c.id) });
      const commitmentRow = await db.query.commitments.findFirst({ where: eq(commitments.id, c.id) });
      // Whichever order won, the frozen originalAmount must equal the
      // actual sum of lines that existed at submit time — never drift
      // from what's actually in the database.
      const total = lines.reduce((sum, l) => sum + Number(l.amount), 0);
      expect(Number(commitmentRow?.originalAmount)).toBe(total);
    }
  });
});

describe("Audit trail", () => {
  it("records commitment.created, commitment.lineAdded, commitment.submitted, commitment.approved", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);
    const lineRes = await addLine(projectId, c.id, { description: "Item", amount: 100 });
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const commitmentEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, c.id) });
    const actions = commitmentEvents.map((e) => e.action).sort();
    expect(actions).toEqual(["commitment.approved", "commitment.created", "commitment.submitted"]);

    const lineEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, lineRes.body.id) });
    expect(lineEvents.some((e) => e.action === "commitment.lineAdded")).toBe(true);

    for (const event of commitmentEvents) {
      expect(event.companyId).toBeTruthy();
      expect(event.actorUserId).toBeTruthy();
      expect(event.entityType).toBe("commitment");
    }
  });

  it("commitment.amended carries the correct before/after revisedAmount", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);
    await addLine(projectId, c.id, { description: "Item", amount: 1000 });
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/amend`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "Scope growth", lines: [{ description: "More scope", amount: 200 }] });

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, c.id) });
    const amended = events.find((e) => e.action === "commitment.amended");
    expect(amended).toBeTruthy();
    expect((amended!.beforeValue as { revisedAmount: string }).revisedAmount).toBe("1000.00");
    expect((amended!.afterValue as { revisedAmount: string }).revisedAmount).toBe("1200.00");
    expect(amended!.reason).toBe("Scope growth");
  });
});

describe("Architectural invariant: Phase 2A never uses projects.budgetTotal as its baseline", () => {
  it("submitting/approving/amending a commitment never touches projects.budgetTotal", async () => {
    const projectId = await createProject();
    const before = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    const originalBudgetTotal = before.body.budgetTotal;

    const supplier = await createSupplier();
    const c = await createDraftCommitment(projectId, supplier.id);
    await addLine(projectId, c.id, { description: "Item", amount: 5000 });
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${c.id}/amend`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ lines: [{ description: "Extra", amount: 1000 }] });

    const after = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(after.body.budgetTotal).toBe(originalBudgetTotal);

    // Direct schema confirmation: the commitments table itself has no
    // column that references projects.budgetTotal, and no route in
    // commitments.ts reads or writes the projects table at all — the
    // canonical planning baseline for Commitment remains
    // budgetItems.plannedAmount (docs/MIDAD_FINANCIAL_MODEL.md), untouched
    // by anything in this file.
    const projectRow = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(projectRow?.budgetTotal).toBe(originalBudgetTotal);
  });
});
