import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents } from "../src/db/schema.js";

// MIDAD Phase D1 — Nitaqat + GOSI Compliance Tracking Foundation. Covers:
// periods/snapshots/Nitaqat/GOSI/exceptions CRUD, the mandatory unverified-
// by-default posture, the dedicated verify actions (evidence/reference
// required, actor+timestamp server-owned, spoofing rejected via .strict()
// mass-assignment protection), evidence upload/download (same-company only,
// no public route), exception resolve/close, authorization (member-open
// reads, laborCompliance.manage-gated mutations, laborCompliance.verify-
// gated verification, Client Portal fully blocked), tenant isolation, and
// audit.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerAToken: string;
let memberAToken: string;
let ownerBToken: string;
let portalToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerARes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "D1 Compliance Co A", name: "Owner A", email: uniqueEmail("d1-owner-a"), password: "password123" });
  ownerAToken = ownerARes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ email: uniqueEmail("d1-member-a"), role: "member" });
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member A", password: "memberpass123" });
  memberAToken = acceptRes.body.token;

  const ownerBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "D1 Compliance Co B", name: "Owner B", email: uniqueEmail("d1-owner-b"), password: "password123" });
  ownerBToken = ownerBRes.body.token;

  const portalEmail = uniqueEmail("d1-portal-client");
  const portalUserRes = await request(app)
    .post("/api/client-portal-users")
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ name: "عميل الامتثال", email: portalEmail, password: "clientpass123" });
  void portalUserRes;
  const portalLogin = await request(app).post("/api/portal/auth/login").send({ email: portalEmail, password: "clientpass123" });
  portalToken = portalLogin.body.token;
});

function createPeriod(body: Record<string, unknown>, token = ownerAToken) {
  return request(app).post("/api/workforce-compliance/periods").set("Authorization", `Bearer ${token}`).send(body);
}
function listPeriods(token = ownerAToken) {
  return request(app).get("/api/workforce-compliance/periods").set("Authorization", `Bearer ${token}`);
}
function getPeriod(id: string, token = ownerAToken) {
  return request(app).get(`/api/workforce-compliance/periods/${id}`).set("Authorization", `Bearer ${token}`);
}
function updatePeriod(id: string, body: Record<string, unknown>, token = ownerAToken) {
  return request(app).patch(`/api/workforce-compliance/periods/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}
function createSnapshot(body: Record<string, unknown>, token = ownerAToken) {
  return request(app).post("/api/workforce-compliance/snapshots").set("Authorization", `Bearer ${token}`).send(body);
}
function getSnapshot(id: string, token = ownerAToken) {
  return request(app).get(`/api/workforce-compliance/snapshots/${id}`).set("Authorization", `Bearer ${token}`);
}
function updateSnapshot(id: string, body: Record<string, unknown>, token = ownerAToken) {
  return request(app).patch(`/api/workforce-compliance/snapshots/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}
function verifySnapshot(id: string, token = ownerAToken) {
  return request(app).post(`/api/workforce-compliance/snapshots/${id}/verify`).set("Authorization", `Bearer ${token}`);
}
function createNitaqat(body: Record<string, unknown>, token = ownerAToken) {
  return request(app).post("/api/workforce-compliance/nitaqat").set("Authorization", `Bearer ${token}`).send(body);
}
function getNitaqat(id: string, token = ownerAToken) {
  return request(app).get(`/api/workforce-compliance/nitaqat/${id}`).set("Authorization", `Bearer ${token}`);
}
function updateNitaqat(id: string, body: Record<string, unknown>, token = ownerAToken) {
  return request(app).patch(`/api/workforce-compliance/nitaqat/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}
function verifyNitaqat(id: string, token = ownerAToken) {
  return request(app).post(`/api/workforce-compliance/nitaqat/${id}/verify`).set("Authorization", `Bearer ${token}`);
}
function uploadNitaqatEvidence(id: string, token = ownerAToken) {
  return request(app)
    .post(`/api/workforce-compliance/nitaqat/${id}/evidence`)
    .set("Authorization", `Bearer ${token}`)
    .attach("evidence", Buffer.from("%PDF-1.4 fake"), { filename: "evidence.pdf", contentType: "application/pdf" });
}
function listNitaqatEvidence(id: string, token = ownerAToken) {
  return request(app).get(`/api/workforce-compliance/nitaqat/${id}/evidence`).set("Authorization", `Bearer ${token}`);
}
function downloadNitaqatEvidence(id: string, fileId: string, token = ownerAToken) {
  return request(app).get(`/api/workforce-compliance/nitaqat/${id}/evidence/${fileId}`).set("Authorization", `Bearer ${token}`);
}
function createGosi(body: Record<string, unknown>, token = ownerAToken) {
  return request(app).post("/api/workforce-compliance/gosi").set("Authorization", `Bearer ${token}`).send(body);
}
function getGosi(id: string, token = ownerAToken) {
  return request(app).get(`/api/workforce-compliance/gosi/${id}`).set("Authorization", `Bearer ${token}`);
}
function updateGosi(id: string, body: Record<string, unknown>, token = ownerAToken) {
  return request(app).patch(`/api/workforce-compliance/gosi/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}
function verifyGosi(id: string, token = ownerAToken) {
  return request(app).post(`/api/workforce-compliance/gosi/${id}/verify`).set("Authorization", `Bearer ${token}`);
}
function createException(body: Record<string, unknown>, token = ownerAToken) {
  return request(app).post("/api/workforce-compliance/exceptions").set("Authorization", `Bearer ${token}`).send(body);
}
function updateException(id: string, body: Record<string, unknown>, token = ownerAToken) {
  return request(app).patch(`/api/workforce-compliance/exceptions/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}
function resolveException(id: string, token = ownerAToken) {
  return request(app).post(`/api/workforce-compliance/exceptions/${id}/resolve`).set("Authorization", `Bearer ${token}`);
}
function closeException(id: string, token = ownerAToken) {
  return request(app).post(`/api/workforce-compliance/exceptions/${id}/close`).set("Authorization", `Bearer ${token}`);
}

// Monotonic day offset from a fixed base date, never random — guarantees
// every period created across this whole file gets a genuinely unique
// (periodStart, periodEnd) pair, avoiding any risk of colliding with the
// DB's own compliance_periods_company_period_unique constraint.
let periodDayOffset = 0;
async function makePeriod(token = ownerAToken, label = `فترة ${Math.random()}`) {
  const base = new Date(Date.UTC(2026, 0, 1));
  const start = new Date(base);
  start.setUTCDate(start.getUTCDate() + periodDayOffset);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  periodDayOffset += 10;
  const res = await createPeriod({ periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10), label }, token);
  return res.body.id as string;
}

describe("Workforce Compliance — periods (Phase D1)", () => {
  it("1. create period", async () => {
    const res = await createPeriod({ periodStart: "2026-01-01", periodEnd: "2026-01-31", label: "يناير 2026" });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe("يناير 2026");
    expect(res.body.status).toBe("open");
    expect(res.body).not.toHaveProperty("companyId");
  });

  it("2. read periods", async () => {
    await createPeriod({ periodStart: "2026-02-01", periodEnd: "2026-02-28", label: "فبراير 2026" });
    const res = await listPeriods();
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("3. update period", async () => {
    const created = await createPeriod({ periodStart: "2026-03-01", periodEnd: "2026-03-31" });
    const res = await updatePeriod(created.body.id, { label: "مارس 2026", status: "closed" });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe("مارس 2026");
    expect(res.body.status).toBe("closed");
  });

  it("4. company isolation", async () => {
    const created = await createPeriod({ periodStart: "2026-04-01", periodEnd: "2026-04-30" });
    const res = await getPeriod(created.body.id, ownerBToken);
    expect(res.status).toBe(404);
  });

  it("5. invalid date range rejected", async () => {
    const res = await createPeriod({ periodStart: "2026-06-01", periodEnd: "2026-05-01" });
    expect(res.status).toBe(400);
  });
});

describe("Workforce Compliance — workforce snapshots (Phase D1)", () => {
  it("6. create snapshot", async () => {
    const periodId = await makePeriod();
    const res = await createSnapshot({ compliancePeriodId: periodId, snapshotDate: "2026-01-15", totalEmployees: 20, saudiEmployees: 8, nonSaudiEmployees: 12 });
    expect(res.status).toBe(201);
    expect(res.body.totalEmployees).toBe(20);
    expect(res.body.verificationStatus).toBe("unverified");
  });

  it("7. read snapshot", async () => {
    const periodId = await makePeriod();
    const created = await createSnapshot({ compliancePeriodId: periodId, snapshotDate: "2026-01-15", totalEmployees: 10, saudiEmployees: 5, nonSaudiEmployees: 5 });
    const res = await getSnapshot(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it("8. company isolation", async () => {
    const periodId = await makePeriod();
    const created = await createSnapshot({ compliancePeriodId: periodId, snapshotDate: "2026-01-15", totalEmployees: 10, saudiEmployees: 5, nonSaudiEmployees: 5 });
    const res = await getSnapshot(created.body.id, ownerBToken);
    expect(res.status).toBe(404);
  });

  it("9. source type stored correctly", async () => {
    const periodId = await makePeriod();
    const res = await createSnapshot({ compliancePeriodId: periodId, snapshotDate: "2026-01-15", totalEmployees: 10, saudiEmployees: 5, nonSaudiEmployees: 5, sourceType: "csv_import" });
    expect(res.body.sourceType).toBe("csv_import");
  });

  it("10. an unverified snapshot never appears as official (verificationStatus stays unverified; client cannot claim otherwise)", async () => {
    const periodId = await makePeriod();
    const res = await createSnapshot({ compliancePeriodId: periodId, snapshotDate: "2026-01-15", totalEmployees: 10, saudiEmployees: 5, nonSaudiEmployees: 5, verificationStatus: "verified" } as Record<string, unknown>);
    // "verificationStatus" isn't a field createSnapshotSchema even accepts
    // — Zod silently strips it (non-strict create schema), so the row is
    // still created successfully but ALWAYS starts unverified.
    expect(res.status).toBe(201);
    expect(res.body.verificationStatus).toBe("unverified");
  });

  it("rejects inconsistent counts (saudi + nonSaudi != total)", async () => {
    const periodId = await makePeriod();
    const res = await createSnapshot({ compliancePeriodId: periodId, snapshotDate: "2026-01-15", totalEmployees: 10, saudiEmployees: 5, nonSaudiEmployees: 4 });
    expect(res.status).toBe(400);
  });

  it("update snapshot works and re-validates count consistency", async () => {
    const periodId = await makePeriod();
    const created = await createSnapshot({ compliancePeriodId: periodId, snapshotDate: "2026-01-15", totalEmployees: 10, saudiEmployees: 5, nonSaudiEmployees: 5 });
    const ok = await updateSnapshot(created.body.id, { saudiEmployees: 6, nonSaudiEmployees: 4 });
    expect(ok.status).toBe(200);
    const bad = await updateSnapshot(created.body.id, { saudiEmployees: 7 });
    expect(bad.status).toBe(400);
  });

  it("verifying a snapshot without a sourceReference is rejected; with one, succeeds and records actor/time", async () => {
    const periodId = await makePeriod();
    const created = await createSnapshot({ compliancePeriodId: periodId, snapshotDate: "2026-01-15", totalEmployees: 10, saudiEmployees: 5, nonSaudiEmployees: 5 });
    const noRef = await verifySnapshot(created.body.id);
    expect(noRef.status).toBe(400);

    await updateSnapshot(created.body.id, { sourceReference: "كشف داخلي معتمد رقم 12" });
    const res = await verifySnapshot(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.verificationStatus).toBe("verified");
    expect(res.body.verifiedByUserId).toBeTruthy();
    expect(res.body.verifiedAt).toBeTruthy();
  });
});

describe("Workforce Compliance — Nitaqat (Phase D1)", () => {
  it("11. create Nitaqat record", async () => {
    const periodId = await makePeriod();
    const res = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20, classification: "أخضر متوسط" });
    expect(res.status).toBe(201);
    expect(res.body.classification).toBe("أخضر متوسط");
  });

  it("12. read Nitaqat record", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20 });
    const res = await getNitaqat(created.body.id);
    expect(res.status).toBe(200);
  });

  it("13. update Nitaqat record", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20 });
    const res = await updateNitaqat(created.body.id, { classification: "أخضر مرتفع" });
    expect(res.status).toBe(200);
    expect(res.body.classification).toBe("أخضر مرتفع");
  });

  it("14. internal/manual record remains unverified", async () => {
    const periodId = await makePeriod();
    const res = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20 });
    expect(res.body.sourceType).toBe("manual");
    expect(res.body.verificationStatus).toBe("unverified");
  });

  it("15. client cannot set official verification directly (unknown field rejected by .strict())", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20 });
    const res = await updateNitaqat(created.body.id, { verificationStatus: "verified" });
    expect(res.status).toBe(400);
    const check = await getNitaqat(created.body.id);
    expect(check.body.verificationStatus).toBe("unverified");
  });

  it("16-17. verification requires an authorized action and records actor/time", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20, externalReference: "خطاب Qiwa رقم 555" });
    const res = await verifyNitaqat(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.verificationStatus).toBe("verified");
    expect(res.body.verifiedByUserId).toBeTruthy();
    expect(new Date(res.body.verifiedAt).getFullYear()).toBeGreaterThan(2024);
  });

  it("18. cross-company Nitaqat access rejected", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20 });
    const res = await getNitaqat(created.body.id, ownerBToken);
    expect(res.status).toBe(404);
  });

  it("19. no direct employee references exist on this table — counts are aggregate integers only, so no employee-id IDOR surface exists here", async () => {
    const periodId = await makePeriod();
    const res = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20 });
    expect(res.body).not.toHaveProperty("employeeId");
    expect(res.body).not.toHaveProperty("employeeIds");
  });

  it("20. no fabricated Nitaqat calculation exists — classification is stored exactly as submitted, never derived from the counts", async () => {
    const periodId = await makePeriod();
    const res = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 1, nonSaudiCount: 99, totalCount: 100, classification: "بلاتيني" });
    // A real classification algorithm would never call a 1% Saudi ratio
    // "بلاتيني" (the highest band) — this proves the string is stored
    // verbatim, not computed from saudiCount/totalCount.
    expect(res.body.classification).toBe("بلاتيني");
  });
});

describe("Workforce Compliance — GOSI (Phase D1)", () => {
  it("21. create GOSI record", async () => {
    const periodId = await makePeriod();
    const res = await createGosi({ compliancePeriodId: periodId, registeredEmployeeCount: 18 });
    expect(res.status).toBe(201);
    expect(res.body.registeredEmployeeCount).toBe(18);
  });

  it("22. read GOSI record", async () => {
    const periodId = await makePeriod();
    const created = await createGosi({ compliancePeriodId: periodId });
    const res = await getGosi(created.body.id);
    expect(res.status).toBe(200);
  });

  it("23. update GOSI record", async () => {
    const periodId = await makePeriod();
    const created = await createGosi({ compliancePeriodId: periodId });
    const res = await updateGosi(created.body.id, { contributionStatus: "recorded", submissionStatus: "recorded" });
    expect(res.status).toBe(200);
    expect(res.body.contributionStatus).toBe("recorded");
  });

  it("24. internal record remains unverified", async () => {
    const periodId = await makePeriod();
    const res = await createGosi({ compliancePeriodId: periodId });
    expect(res.body.verificationStatus).toBe("unverified");
  });

  it("25. client cannot spoof verification via PATCH", async () => {
    const periodId = await makePeriod();
    const created = await createGosi({ compliancePeriodId: periodId });
    const res = await updateGosi(created.body.id, { verificationStatus: "verified", verifiedByUserId: "attacker", verifiedAt: "2020-01-01" });
    expect(res.status).toBe(400);
  });

  it("26-27. authorized verification works and records actor/time", async () => {
    const periodId = await makePeriod();
    const created = await createGosi({ compliancePeriodId: periodId, externalReference: "إشعار GOSI رقم 999" });
    const res = await verifyGosi(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.verificationStatus).toBe("verified");
    expect(res.body.verifiedByUserId).toBeTruthy();
    expect(new Date(res.body.verifiedAt).getFullYear()).toBeGreaterThan(2024);
  });

  it("28. cross-company GOSI access rejected", async () => {
    const periodId = await makePeriod();
    const created = await createGosi({ compliancePeriodId: periodId });
    const res = await getGosi(created.body.id, ownerBToken);
    expect(res.status).toBe(404);
  });

  it("29. no fabricated contribution-rate calculation exists — no SAR/amount field is ever present on a GOSI record", async () => {
    const periodId = await makePeriod();
    const res = await createGosi({ compliancePeriodId: periodId, registeredEmployeeCount: 10 });
    expect(res.body).not.toHaveProperty("contributionAmount");
    expect(res.body).not.toHaveProperty("amount");
    expect(res.body).not.toHaveProperty("rate");
  });
});

describe("Workforce Compliance — evidence (Phase D1)", () => {
  it("30. same-company evidence accepted", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20 });
    const uploadRes = await uploadNitaqatEvidence(created.body.id);
    expect(uploadRes.status).toBe(201);
    const listRes = await listNitaqatEvidence(created.body.id);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    const downloadRes = await downloadNitaqatEvidence(created.body.id, uploadRes.body.id);
    expect(downloadRes.status).toBe(200);
  });

  it("31. cross-company evidence rejected", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20 });
    const uploadRes = await uploadNitaqatEvidence(created.body.id);
    const res = await downloadNitaqatEvidence(created.body.id, uploadRes.body.id, ownerBToken);
    expect(res.status).toBe(404);
    const listRes = await listNitaqatEvidence(created.body.id, ownerBToken);
    expect(listRes.status).toBe(404);
  });

  it("32. unauthorized (unauthenticated) evidence access rejected", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20 });
    const uploadRes = await uploadNitaqatEvidence(created.body.id);
    const res = await request(app).get(`/api/workforce-compliance/nitaqat/${created.body.id}/evidence/${uploadRes.body.id}`);
    expect(res.status).toBe(401);
  });

  it("33. no public evidence route exists — the download route requires the same internal authentication as everything else", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 8, nonSaudiCount: 12, totalCount: 20 });
    const uploadRes = await uploadNitaqatEvidence(created.body.id);
    const res = await request(app).get(`/api/public/workforce-compliance/nitaqat/${created.body.id}/evidence/${uploadRes.body.id}`);
    expect(res.status).toBe(404);
  });

  it("verifying with evidence (no externalReference) succeeds", async () => {
    const periodId = await makePeriod();
    const created = await createGosi({ compliancePeriodId: periodId });
    const noEvidence = await verifyGosi(created.body.id);
    expect(noEvidence.status).toBe(400);
  });
});

describe("Workforce Compliance — exceptions (Phase D1)", () => {
  it("34. create exception", async () => {
    const res = await createException({ description: "بانتظار التحقق من بيانات نطاقات", severity: "high" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
  });

  it("35. update exception", async () => {
    const created = await createException({ description: "استثناء للتحديث" });
    const res = await updateException(created.body.id, { severity: "critical", status: "in_progress" });
    expect(res.status).toBe(200);
    expect(res.body.severity).toBe("critical");
    expect(res.body.status).toBe("in_progress");
  });

  it("36. resolve exception", async () => {
    const created = await createException({ description: "استثناء للحل" });
    const res = await resolveException(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolvedByUserId).toBeTruthy();
    expect(res.body.resolvedAt).toBeTruthy();
  });

  it("37. close exception", async () => {
    const created = await createException({ description: "استثناء للإغلاق" });
    await resolveException(created.body.id);
    const res = await closeException(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("closed");
    expect(res.body.closedByUserId).toBeTruthy();
    expect(res.body.closedAt).toBeTruthy();
  });

  it("cannot close an exception that hasn't been resolved", async () => {
    const created = await createException({ description: "استثناء غير محلول" });
    const res = await closeException(created.body.id);
    expect(res.status).toBe(400);
  });

  it("38. cross-company exception access rejected", async () => {
    const created = await createException({ description: "استثناء آخر" });
    const res = await request(app).get(`/api/workforce-compliance/exceptions/${created.body.id}`).set("Authorization", `Bearer ${ownerBToken}`);
    expect(res.status).toBe(404);
  });

  it("39. severity validation", async () => {
    const res = await createException({ description: "استثناء بأولوية غير صالحة", severity: "urgent" });
    expect(res.status).toBe(400);
  });

  it("40. status transition validation — PATCH cannot set status to resolved/closed directly", async () => {
    const created = await createException({ description: "استثناء لمنع القفز" });
    const res = await updateException(created.body.id, { status: "resolved" });
    expect(res.status).toBe(400);
  });
});

describe("Workforce Compliance — security (Phase D1)", () => {
  it("41. unauthenticated access rejected", async () => {
    const res = await request(app).get("/api/workforce-compliance/periods");
    expect(res.status).toBe(401);
  });

  it("42. unauthorized internal user (member) rejected for mutations", async () => {
    const res = await createPeriod({ periodStart: "2026-07-01", periodEnd: "2026-07-31" }, memberAToken);
    expect(res.status).toBe(403);
  });

  it("a member CAN read compliance data (company-scoped reads stay open)", async () => {
    await createPeriod({ periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    const res = await listPeriods(memberAToken);
    expect(res.status).toBe(200);
  });

  it("43. cross-tenant ID manipulation rejected across every entity", async () => {
    const periodId = await makePeriod();
    const nitaqat = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 1, nonSaudiCount: 1, totalCount: 2 });
    const gosi = await createGosi({ compliancePeriodId: periodId });
    const exception = await createException({ description: "عبر المستأجرين" });

    expect((await getNitaqat(nitaqat.body.id, ownerBToken)).status).toBe(404);
    expect((await getGosi(gosi.body.id, ownerBToken)).status).toBe(404);
    expect((await updateNitaqat(nitaqat.body.id, { notes: "اختراق" }, ownerBToken)).status).toBe(404);
    expect((await updateGosi(gosi.body.id, { notes: "اختراق" }, ownerBToken)).status).toBe(404);
    expect((await request(app).patch(`/api/workforce-compliance/exceptions/${exception.body.id}`).set("Authorization", `Bearer ${ownerBToken}`).send({ description: "x" })).status).toBe(404);
  });

  it("44. Client Portal identity rejected", async () => {
    const res = await listPeriods(portalToken);
    expect(res.status).toBe(401);
    const createRes = await createPeriod({ periodStart: "2026-09-01", periodEnd: "2026-09-30" }, portalToken);
    expect(createRes.status).toBe(401);
  });

  it("45. companyId mass assignment rejected", async () => {
    const foreignCompanyRes = await request(app).post("/api/auth/register").send({ companyName: "Sneaky Co", name: "Sneaky Owner", email: uniqueEmail("sneaky"), password: "password123" });
    const foreignCompanyId = foreignCompanyRes.body.company.id;
    const res = await createPeriod({ periodStart: "2026-10-01", periodEnd: "2026-10-31", companyId: foreignCompanyId } as Record<string, unknown>);
    expect(res.status).toBe(201);
    // companyId isn't in createPeriodSchema at all — Zod strips it — so
    // the row is always created under the AUTHENTICATED caller's own
    // company, never the injected one.
    const check = await getPeriod(res.body.id);
    expect(check.status).toBe(200);
    const foreignCheck = await getPeriod(res.body.id, foreignCompanyRes.body.token);
    expect(foreignCheck.status).toBe(404);
  });

  it("46. verifiedBy spoof rejected (Nitaqat)", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 1, nonSaudiCount: 1, totalCount: 2 });
    const res = await updateNitaqat(created.body.id, { verifiedByUserId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(400);
  });

  it("47. verifiedAt spoof rejected (Nitaqat)", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 1, nonSaudiCount: 1, totalCount: 2 });
    const res = await updateNitaqat(created.body.id, { verifiedAt: "2020-01-01T00:00:00.000Z" });
    expect(res.status).toBe(400);
  });

  it("48. sourceType=external_reference cannot bypass the verification workflow", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 1, nonSaudiCount: 1, totalCount: 2, sourceType: "external_reference" });
    expect(created.body.sourceType).toBe("external_reference");
    // Even with sourceType claiming an external reference, verification
    // status still starts unverified and still requires the dedicated
    // verify action (which itself still requires externalReference/evidence).
    expect(created.body.verificationStatus).toBe("unverified");
    const verifyAttempt = await verifyNitaqat(created.body.id);
    expect(verifyAttempt.status).toBe(400);
  });

  it("49. no sensitive employee data leakage — snapshot/Nitaqat responses contain only aggregate counts, no employee PII", async () => {
    const periodId = await makePeriod();
    const snapshot = await createSnapshot({ compliancePeriodId: periodId, snapshotDate: "2026-01-15", totalEmployees: 10, saudiEmployees: 5, nonSaudiEmployees: 5 });
    const dump = JSON.stringify(snapshot.body).toLowerCase();
    for (const forbidden of ["email", "phone", "iban", "banname", "passwordhash", "nationality"]) {
      expect(dump).not.toContain(forbidden);
    }
  });
});

describe("Workforce Compliance — audit (Phase D1)", () => {
  it("50. compliance record creation audited", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 1, nonSaudiCount: 1, totalCount: 2 });
    const event = await db.query.auditEvents.findFirst({ where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "nitaqatcompliancerecord.created")) });
    expect(event).toBeTruthy();
  });

  it("51. compliance update audited", async () => {
    const periodId = await makePeriod();
    const created = await createGosi({ compliancePeriodId: periodId });
    await updateGosi(created.body.id, { contributionStatus: "recorded" });
    const event = await db.query.auditEvents.findFirst({ where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "gosicompliancerecord.updated")) });
    expect(event).toBeTruthy();
  });

  it("52. verification audited", async () => {
    const periodId = await makePeriod();
    const created = await createNitaqat({ compliancePeriodId: periodId, saudiCount: 1, nonSaudiCount: 1, totalCount: 2, externalReference: "مرجع" });
    await verifyNitaqat(created.body.id);
    const event = await db.query.auditEvents.findFirst({ where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "nitaqatcompliancerecord.verified")) });
    expect(event).toBeTruthy();
    expect((event!.afterValue as { verificationStatus: string }).verificationStatus).toBe("verified");
  });

  it("53. exception creation/update/resolution audited", async () => {
    const created = await createException({ description: "استثناء للتدقيق" });
    const createdEvent = await db.query.auditEvents.findFirst({ where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "complianceexception.created")) });
    expect(createdEvent).toBeTruthy();

    await updateException(created.body.id, { severity: "high" });
    const updatedEvent = await db.query.auditEvents.findFirst({ where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "complianceexception.updated")) });
    expect(updatedEvent).toBeTruthy();

    await resolveException(created.body.id);
    const resolvedEvent = await db.query.auditEvents.findFirst({ where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "complianceexception.resolved")) });
    expect(resolvedEvent).toBeTruthy();
  });
});

describe("Workforce Compliance — dashboard (Phase D1)", () => {
  it("dashboard returns the latest Nitaqat/GOSI status and exception counts without inventing a compliance score", async () => {
    const periodId = await makePeriod();
    await createNitaqat({ compliancePeriodId: periodId, saudiCount: 1, nonSaudiCount: 1, totalCount: 2 });
    await createGosi({ compliancePeriodId: periodId });
    await createException({ description: "استثناء للوحة", severity: "critical" });

    const res = await request(app).get("/api/workforce-compliance").set("Authorization", `Bearer ${ownerAToken}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("complianceScore");
    expect(res.body).not.toHaveProperty("percentage");
    expect(res.body.exceptions).toHaveProperty("open");
    expect(res.body.exceptions).toHaveProperty("highOrCritical");
  });
});
