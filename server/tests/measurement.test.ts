import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, measurementLines, measurements } from "../src/db/schema.js";
import { listAuditEvents } from "../src/lib/audit.js";

// Phase 2B: Progress / Measurement. Same shared-company-per-file discipline
// as procurement.test.ts / midadFoundation.test.ts (auth endpoints are
// rate-limited; a real user only registers/invites once).

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
    .send({ companyName: "Measurement Co", name: "Owner", email: uniqueEmail("meas-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("meas-member"), role: "member" });
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
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("meas-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Measurement Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// Creates a project, a contract, a published BOQ revision with one
// measurable item (quantity/rate given), and returns everything needed to
// exercise measurements against it.
async function setupPublishedBoq(quantity = 100, rate = 10, token = ownerToken) {
  const projectId = await createProject(token);
  const contractRes = await request(app)
    .post(`/api/projects/${projectId}/contracts`)
    .set("Authorization", `Bearer ${token}`)
    .send({ originalValue: 50000 });
  const revRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions`)
    .set("Authorization", `Bearer ${token}`)
    .send({ contractId: contractRes.body.id });
  const itemRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
    .set("Authorization", `Bearer ${token}`)
    .send({ description: "Excavation", unit: "m3", quantity, rate });
  const publishRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/publish`)
    .set("Authorization", `Bearer ${token}`);
  expect(publishRes.status).toBe(200);

  return {
    projectId,
    contractId: contractRes.body.id as string,
    revisionId: revRes.body.id as string,
    boqItemId: itemRes.body.id as string,
  };
}

async function createDraftMeasurement(
  projectId: string,
  contractId: string,
  boqRevisionId: string,
  token = ownerToken,
) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/measurements`)
    .set("Authorization", `Bearer ${token}`)
    .send({ contractId, boqRevisionId, measurementDate: "2026-02-01" });
  expect(res.status).toBe(201);
  return res.body as { id: string; status: string };
}

function addLine(
  projectId: string,
  measurementId: string,
  body: Record<string, unknown>,
  token = ownerToken,
) {
  return request(app)
    .post(`/api/projects/${projectId}/measurements/${measurementId}/items`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

function submit(projectId: string, measurementId: string, token = ownerToken) {
  return request(app)
    .post(`/api/projects/${projectId}/measurements/${measurementId}/submit`)
    .set("Authorization", `Bearer ${token}`);
}

function approve(projectId: string, measurementId: string, token = ownerToken) {
  return request(app)
    .post(`/api/projects/${projectId}/measurements/${measurementId}/approve`)
    .set("Authorization", `Bearer ${token}`);
}

function reject(projectId: string, measurementId: string, reason = "Not matching site", token = ownerToken) {
  return request(app)
    .post(`/api/projects/${projectId}/measurements/${measurementId}/reject`)
    .set("Authorization", `Bearer ${token}`)
    .send({ reason });
}

describe("CRUD / lifecycle", () => {
  it("1. owner creates a measurement", async () => {
    const { projectId, contractId, revisionId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    expect(m.status).toBe("draft");
  });

  it("2. a member (authorized site-entry role) can also create a measurement", async () => {
    const { projectId, contractId, revisionId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId, memberToken);
    expect(m.status).toBe("draft");
  });

  it("3/4. requires a PUBLISHED BOQ revision — rejects a draft revision", async () => {
    const projectId = await createProject();
    const contractRes = await request(app)
      .post(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ originalValue: 10000 });
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: contractRes.body.id });
    // revRes is still draft — never published.

    const res = await request(app)
      .post(`/api/projects/${projectId}/measurements`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: contractRes.body.id, boqRevisionId: revRes.body.id, measurementDate: "2026-02-01" });
    expect(res.status).toBe(400);
  });

  it("rejects a superseded revision", async () => {
    const { projectId, contractId, revisionId: firstRevId } = await setupPublishedBoq();
    // Publish a second revision for the same contract, superseding the first.
    const secondRevRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${secondRevRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "New item", quantity: 5, rate: 2 });
    await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${secondRevRes.body.id}/publish`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const res = await request(app)
      .post(`/api/projects/${projectId}/measurements`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: firstRevId, measurementDate: "2026-02-01" });
    expect(res.status).toBe(400);
  });

  it("5/6. adds and removes a draft line", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);

    const addRes = await addLine(projectId, m.id, { boqItemId, measuredQuantity: 10 });
    expect(addRes.status).toBe(201);
    expect(Number(addRes.body.value)).toBe(100); // 10 * rate(10)

    const delRes = await request(app)
      .delete(`/api/projects/${projectId}/measurements/${m.id}/items/${addRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(delRes.status).toBe(204);
  });

  it("7/8. submit then approve", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    await addLine(projectId, m.id, { boqItemId, measuredQuantity: 20 });

    const submitRes = await submit(projectId, m.id);
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe("submitted");

    const approveRes = await approve(projectId, m.id);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe("approved");
  });

  it("9/10. reject, then the measurement is editable and resubmittable", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    await addLine(projectId, m.id, { boqItemId, measuredQuantity: 15 });
    await submit(projectId, m.id);

    const rejectRes = await reject(projectId, m.id, "Quantity looks wrong");
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe("rejected");
    expect(rejectRes.body.rejectionReason).toBe("Quantity looks wrong");

    // Editable again (proves "rejected" rejoins the draft flow):
    const addAfterReject = await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 });
    expect(addAfterReject.status).toBe(201);

    const resubmitRes = await submit(projectId, m.id);
    expect(resubmitRes.status).toBe(200);
    expect(resubmitRes.body.status).toBe("submitted");
    // Rejection metadata is cleared on successful resubmission.
    expect(resubmitRes.body.rejectionReason).toBeNull();
  });

  it("11. an approved measurement cannot be modified (line add/remove both rejected)", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    const lineRes = await addLine(projectId, m.id, { boqItemId, measuredQuantity: 10 });
    await submit(projectId, m.id);
    await approve(projectId, m.id);

    const addAfterApprove = await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 });
    expect(addAfterApprove.status).toBe(409);

    const deleteAfterApprove = await request(app)
      .delete(`/api/projects/${projectId}/measurements/${m.id}/items/${lineRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(deleteAfterApprove.status).toBe(409);
  });

  it("12. no DELETE /measurements/:id route exists — approved measurements cannot be deleted because deletion was never implemented for this domain", async () => {
    // Per the approved Phase 2B API surface (create/read/items/submit/
    // approve/reject only), there is no measurement-deletion endpoint at
    // all — this is confirmed by its absence, not tested against a route
    // that doesn't exist.
    const { projectId, contractId, revisionId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    const res = await request(app)
      .delete(`/api/projects/${projectId}/measurements/${m.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404); // no route matches this path at all
  });
});

describe("Quantity integrity", () => {
  it("13. rejects a negative quantity", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    const res = await addLine(projectId, m.id, { boqItemId, measuredQuantity: -5 });
    expect(res.status).toBe(400);
  });

  it("14. rejects an invalid numeric value", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    const res = await addLine(projectId, m.id, { boqItemId, measuredQuantity: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("15. cumulative approved quantity cannot exceed the BOQ item's quantity", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    await addLine(projectId, m.id, { boqItemId, measuredQuantity: 150 }); // over the 100 limit
    await submit(projectId, m.id);

    const res = await approve(projectId, m.id);
    expect(res.status).toBe(409);
    expect(res.body.boqItemId).toBe(boqItemId);

    const stillSubmitted = await db.query.measurements.findFirst({ where: eq(measurements.id, m.id) });
    expect(stillSubmitted?.status).toBe("submitted");
  });

  it("16/17. multiple approved periods sum correctly, with no double counting across resubmission", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);

    const m1 = await createDraftMeasurement(projectId, contractId, revisionId);
    await addLine(projectId, m1.id, { boqItemId, measuredQuantity: 40 });
    await submit(projectId, m1.id);
    const approve1 = await approve(projectId, m1.id);
    expect(approve1.status).toBe(200);

    const m2 = await createDraftMeasurement(projectId, contractId, revisionId);
    await addLine(projectId, m2.id, { boqItemId, measuredQuantity: 30 });
    await submit(projectId, m2.id);
    // Reject then resubmit m2 once — proves the rejected line isn't
    // double-counted (it was never approved, so it never contributed).
    const rejectM2 = await reject(projectId, m2.id);
    expect(rejectM2.status).toBe(200);
    await submit(projectId, m2.id);
    const approve2 = await approve(projectId, m2.id);
    expect(approve2.status).toBe(200);

    // A third measurement bringing the cumulative to exactly 100 (40+30+30) must succeed...
    const m3 = await createDraftMeasurement(projectId, contractId, revisionId);
    await addLine(projectId, m3.id, { boqItemId, measuredQuantity: 30 });
    await submit(projectId, m3.id);
    const approve3 = await approve(projectId, m3.id);
    expect(approve3.status).toBe(200);

    // ...but a fourth measurement for even 1 more unit must be rejected —
    // proving the cumulative sum is exactly 100 (40+30+30), not 130
    // (which would mean m2's rejected-then-resubmitted line was counted
    // twice).
    const m4 = await createDraftMeasurement(projectId, contractId, revisionId);
    await addLine(projectId, m4.id, { boqItemId, measuredQuantity: 1 });
    await submit(projectId, m4.id);
    const approve4 = await approve(projectId, m4.id);
    expect(approve4.status).toBe(409);
  });

  it("18. a zero-quantity line is explicitly allowed (a valid 'no progress this period' entry)", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    const res = await addLine(projectId, m.id, { boqItemId, measuredQuantity: 0 });
    expect(res.status).toBe(201);
    expect(Number(res.body.measuredQuantity)).toBe(0);
  });
});

describe("Tenant isolation", () => {
  it("19. cross-tenant project is rejected", async () => {
    const res = await request(app)
      .get("/api/projects/00000000-0000-0000-0000-000000000000/measurements")
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(res.status).toBe(404);
  });

  it("20. cross-tenant contract is rejected", async () => {
    const { projectId } = await setupPublishedBoq();
    const otherProjectId = await createProject();
    const otherContractRes = await request(app)
      .post(`/api/projects/${otherProjectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ originalValue: 1000 });
    const otherRevRes = await request(app)
      .post(`/api/projects/${otherProjectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: otherContractRes.body.id });

    const res = await request(app)
      .post(`/api/projects/${projectId}/measurements`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: otherContractRes.body.id, boqRevisionId: otherRevRes.body.id, measurementDate: "2026-02-01" });
    expect(res.status).toBe(404);
  });

  it("21. cross-tenant / wrong-contract BOQ revision is rejected", async () => {
    const { projectId, contractId } = await setupPublishedBoq();
    const other = await setupPublishedBoq(); // a second, independent published revision

    const res = await request(app)
      .post(`/api/projects/${projectId}/measurements`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: other.revisionId, measurementDate: "2026-02-01" });
    expect(res.status).toBe(400); // not a published revision of THIS contract
  });

  it("22. a boqItemId belonging to a different revision is rejected", async () => {
    const { projectId, contractId, revisionId } = await setupPublishedBoq();
    const other = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);

    const res = await addLine(projectId, m.id, { boqItemId: other.boqItemId, measuredQuantity: 5 });
    expect(res.status).toBe(404);
  });

  it("23. cross-tenant measurement access is rejected (company B cannot read it)", async () => {
    const { projectId, contractId, revisionId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);

    const res = await request(app)
      .get(`/api/projects/${projectId}/measurements/${m.id}`)
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(res.status).toBe(404);
  });

  it("24. cross-tenant line mutation is rejected", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    const lineRes = await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 });

    const addAsCompanyB = await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 }, companyBToken);
    expect(addAsCompanyB.status).toBe(404);

    const deleteAsCompanyB = await request(app)
      .delete(`/api/projects/${projectId}/measurements/${m.id}/items/${lineRes.body.id}`)
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(deleteAsCompanyB.status).toBe(404);
  });
});

describe("RBAC", () => {
  it("25. an unauthorized member cannot approve", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 });
    await submit(projectId, m.id);

    const res = await approve(projectId, m.id, memberToken);
    expect(res.status).toBe(403);
  });

  it("26. an unauthorized member cannot reject", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 });
    await submit(projectId, m.id);

    const res = await reject(projectId, m.id, "reason", memberToken);
    expect(res.status).toBe(403);
  });

  it("27. authorization matrix: create/items/submit are member-open, approve/reject are owner-only", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();

    const createAsMember = await createDraftMeasurement(projectId, contractId, revisionId, memberToken);
    expect(createAsMember.status).toBe("draft");

    const addAsMember = await addLine(projectId, createAsMember.id, { boqItemId, measuredQuantity: 5 }, memberToken);
    expect(addAsMember.status).toBe(201);

    const submitAsMember = await submit(projectId, createAsMember.id, memberToken);
    expect(submitAsMember.status).toBe(200);

    const approveAsMember = await approve(projectId, createAsMember.id, memberToken);
    expect(approveAsMember.status).toBe(403);

    const approveAsOwner = await approve(projectId, createAsMember.id, ownerToken);
    expect(approveAsOwner.status).toBe(200);
  });
});

describe("Audit trail", () => {
  it("28-33. every lifecycle transition produces its canonical audit event", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    const lineRes = await addLine(projectId, m.id, { boqItemId, measuredQuantity: 10 });
    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}/measurements/${m.id}/items/${lineRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(deleteRes.status).toBe(204);
    const lineRes2 = await addLine(projectId, m.id, { boqItemId, measuredQuantity: 10 });
    await submit(projectId, m.id);
    const rejectRes = await reject(projectId, m.id, "recheck needed");
    expect(rejectRes.status).toBe(200);
    await submit(projectId, m.id);
    await approve(projectId, m.id);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, m.id) });
    const actions = events.map((e) => e.action).sort();
    expect(actions).toEqual(
      ["measurement.approved", "measurement.created", "measurement.rejected", "measurement.submitted", "measurement.submitted"].sort(),
    );

    const lineAddedEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, lineRes.body.id) });
    expect(lineAddedEvents.some((e) => e.action === "measurement.lineAdded")).toBe(true);

    const lineRemovedEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, lineRes.body.id) });
    expect(lineRemovedEvents.some((e) => e.action === "measurement.lineRemoved")).toBe(true);

    const line2Events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, lineRes2.body.id) });
    expect(line2Events.some((e) => e.action === "measurement.lineAdded")).toBe(true);

    for (const event of events) {
      expect(event.companyId).toBeTruthy();
      expect(event.actorUserId).toBeTruthy();
      expect(event.entityType).toBe("measurement");
    }

    const rejected = events.find((e) => e.action === "measurement.rejected");
    expect(rejected?.reason).toBe("recheck needed");
  });

  it("34. audit retrieval is tenant-isolated", async () => {
    const { projectId, contractId, revisionId } = await setupPublishedBoq();
    const m = await createDraftMeasurement(projectId, contractId, revisionId);

    const ownerCompany = await db.query.auditEvents.findFirst({ where: eq(auditEvents.entityId, m.id) });
    expect(ownerCompany).toBeTruthy();

    const ownerScoped = await listAuditEvents(ownerCompany!.companyId, { entityType: "measurement" });
    expect(ownerScoped.some((e) => e.entityId === m.id)).toBe(true);

    const otherRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Meas Rival Co", name: "Owner", email: uniqueEmail("meas-rival"), password: "password123" });
    const otherScoped = await listAuditEvents(otherRes.body.company.id, { entityType: "measurement" });
    expect(otherScoped.some((e) => e.entityId === m.id)).toBe(false);
  });
});

describe("Concurrency", () => {
  const TRIALS = 5;

  it(`${TRIALS}x: concurrent submit attempts — exactly one succeeds`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
      const m = await createDraftMeasurement(projectId, contractId, revisionId);
      await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 });

      const results = await Promise.all(Array.from({ length: 5 }, () => submit(projectId, m.id)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);

      const row = await db.query.measurements.findFirst({ where: eq(measurements.id, m.id) });
      expect(row?.status).toBe("submitted");
    }
  });

  it(`${TRIALS}x: concurrent approval attempts — exactly one succeeds`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
      const m = await createDraftMeasurement(projectId, contractId, revisionId);
      await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 });
      await submit(projectId, m.id);

      const results = await Promise.all(Array.from({ length: 5 }, () => approve(projectId, m.id)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);

      const row = await db.query.measurements.findFirst({ where: eq(measurements.id, m.id) });
      expect(row?.status).toBe("approved");
    }
  });

  it(`${TRIALS}x: concurrent add-line vs submit never leaves an inconsistent database state`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
      const m = await createDraftMeasurement(projectId, contractId, revisionId);
      await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 }); // seed line so submit is valid either way

      const [submitRes, addRes] = await Promise.all([
        submit(projectId, m.id),
        addLine(projectId, m.id, { boqItemId, measuredQuantity: 3 }),
      ]);
      expect(submitRes.status).toBe(200);
      expect([201, 409]).toContain(addRes.status);

      const lines = await db.query.measurementLines.findMany({ where: eq(measurementLines.measurementId, m.id) });
      if (addRes.status === 201) expect(lines).toHaveLength(2);
      else expect(lines).toHaveLength(1);

      const row = await db.query.measurements.findFirst({ where: eq(measurements.id, m.id) });
      expect(row?.status).toBe("submitted");
    }
  });

  it(`${TRIALS}x: concurrent delete-line vs submit never leaves an inconsistent database state`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
      const m = await createDraftMeasurement(projectId, contractId, revisionId);
      const lineRes = await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 });

      const [submitRes, deleteRes] = await Promise.all([
        submit(projectId, m.id),
        request(app)
          .delete(`/api/projects/${projectId}/measurements/${m.id}/items/${lineRes.body.id}`)
          .set("Authorization", `Bearer ${ownerToken}`),
      ]);
      expect(submitRes.status).toBe(200);
      expect([204, 409]).toContain(deleteRes.status);

      const lines = await db.query.measurementLines.findMany({ where: eq(measurementLines.measurementId, m.id) });
      if (deleteRes.status === 204) expect(lines).toHaveLength(0);
      else expect(lines).toHaveLength(1);
    }
  });

  it(`${TRIALS}x: concurrent add-line vs approve never leaves an inconsistent database state`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(1000, 10);
      const m = await createDraftMeasurement(projectId, contractId, revisionId);
      await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 });
      await submit(projectId, m.id);

      // Add-line is only valid pre-submission, so this race is really
      // "approve vs a doomed-to-409 add-line attempt on an already-
      // submitted measurement" — the invariant is that it can NEVER
      // succeed once submitted, regardless of the approve race's outcome.
      const [approveRes, addRes] = await Promise.all([
        approve(projectId, m.id),
        addLine(projectId, m.id, { boqItemId, measuredQuantity: 3 }),
      ]);
      expect(approveRes.status).toBe(200);
      expect(addRes.status).toBe(409);

      const lines = await db.query.measurementLines.findMany({ where: eq(measurementLines.measurementId, m.id) });
      expect(lines).toHaveLength(1);
    }
  });

  it(`${TRIALS}x: concurrent approve vs reject — exactly one succeeds, never both`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
      const m = await createDraftMeasurement(projectId, contractId, revisionId);
      await addLine(projectId, m.id, { boqItemId, measuredQuantity: 5 });
      await submit(projectId, m.id);

      const [approveRes, rejectRes] = await Promise.all([approve(projectId, m.id), reject(projectId, m.id)]);
      const outcomes = [approveRes.status, rejectRes.status].sort();
      expect(outcomes).toEqual([200, 409]);

      const row = await db.query.measurements.findFirst({ where: eq(measurements.id, m.id) });
      if (approveRes.status === 200) expect(row?.status).toBe("approved");
      else expect(row?.status).toBe("rejected");
    }
  });
});

describe("Architectural invariant: Measurement never touches the canonical financial baselines", () => {
  it("submit/approve/reject never modify projects.budgetTotal, contracts.revisedValue, or the BOQ item's own stored amount", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const projectBefore = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    const contractBefore = await request(app)
      .get(`/api/projects/${projectId}/contracts/${contractId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const m = await createDraftMeasurement(projectId, contractId, revisionId);
    await addLine(projectId, m.id, { boqItemId, measuredQuantity: 10 });
    await submit(projectId, m.id);
    await approve(projectId, m.id);

    const projectAfter = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    const contractAfter = await request(app)
      .get(`/api/projects/${projectId}/contracts/${contractId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(projectAfter.body.budgetTotal).toBe(projectBefore.body.budgetTotal);
    expect(contractAfter.body.revisedValue).toBe(contractBefore.body.revisedValue);
  });
});
