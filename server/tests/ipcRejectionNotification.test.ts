import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { ipcs } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

// P0-3 pre-launch hardening — the one notification producer this sprint
// wires with a genuinely defined recipient: ipcs.submittedBy, set
// atomically by the submit() route and never anything this task invents.
// (Budget-alert and change-order-decision producers are deliberately NOT
// wired — see the P0 sprint report for the exact missing business rule in
// each case: budget_alerts has no recipient/subscriber concept anywhere in
// the schema, and change_orders has no creator/requester column at all.)

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let submitterToken: string, submitterId: string;
let rejectorToken: string;
let companyBToken: string;

beforeAll(async () => {
  await resetDb();

  // The submitter is a SECOND owner in the same company (IPC submit/reject
  // both require ipc.manage, which is owner-only — inviting a second owner
  // is the only way to make the recipient of this notification a genuinely
  // different person from the one who rejects it, proving the notification
  // targets the submitter, not the acting user).
  const founder = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "IPC Notif Co", name: "Founder", email: uniqueEmail("ipc-notif-founder"), password: "password123" });
  rejectorToken = founder.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${rejectorToken}`)
    .send({ email: uniqueEmail("ipc-notif-submitter"), role: "owner" });
  expect(inviteRes.status).toBe(201);
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{64})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Submitter", password: "password123" });
  expect(acceptRes.status).toBe(201);
  submitterToken = acceptRes.body.token;
  submitterId = acceptRes.body.user.id;

  const companyB = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("ipc-notif-other"), password: "password123" });
  companyBToken = companyB.body.token;
});

async function setupSubmittedIpc(): Promise<{ projectId: string; ipcId: string; ipcNumber: number }> {
  const projectRes = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${rejectorToken}`)
    .send({ name: `IPC Notif Project ${Math.random()}` });
  const projectId = projectRes.body.id as string;

  const contractRes = await request(app)
    .post(`/api/projects/${projectId}/contracts`)
    .set("Authorization", `Bearer ${rejectorToken}`)
    .send({ originalValue: 50000 });
  const revRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions`)
    .set("Authorization", `Bearer ${rejectorToken}`)
    .send({ contractId: contractRes.body.id });
  const itemRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
    .set("Authorization", `Bearer ${rejectorToken}`)
    .send({ description: "Excavation", unit: "m3", quantity: 100, rate: 10 });
  await request(app)
    .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/publish`)
    .set("Authorization", `Bearer ${rejectorToken}`);

  const mRes = await request(app)
    .post(`/api/projects/${projectId}/measurements`)
    .set("Authorization", `Bearer ${rejectorToken}`)
    .send({ contractId: contractRes.body.id, boqRevisionId: revRes.body.id, measurementDate: "2026-02-01" });
  await request(app)
    .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/items`)
    .set("Authorization", `Bearer ${rejectorToken}`)
    .send({ boqItemId: itemRes.body.id, measuredQuantity: 50 });
  await request(app)
    .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/submit`)
    .set("Authorization", `Bearer ${rejectorToken}`);
  await request(app)
    .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/approve`)
    .set("Authorization", `Bearer ${rejectorToken}`);

  const ipcRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs`)
    .set("Authorization", `Bearer ${submitterToken}`)
    .send({ contractId: contractRes.body.id, boqRevisionId: revRes.body.id, periodStart: "2026-02-01", periodEnd: "2026-02-28" });
  const ipcId = ipcRes.body.id as string;

  await request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcId}/items`)
    .set("Authorization", `Bearer ${submitterToken}`)
    .send({ boqItemId: itemRes.body.id, currentQuantity: 50 });

  // Submitted by the SECOND owner — this is the recipient the notification
  // must target.
  const submitRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcId}/submit`)
    .set("Authorization", `Bearer ${submitterToken}`);
  expect(submitRes.status).toBe(200);

  return { projectId, ipcId, ipcNumber: submitRes.body.ipcNumber };
}

describe("IPC rejection -> notification producer", () => {
  it("rejecting a submitted IPC creates exactly one notification for the person who submitted it, not the person who rejected it", async () => {
    const { projectId, ipcId, ipcNumber } = await setupSubmittedIpc();

    // Rejected by the FOUNDER — a different user from the submitter.
    const rejectRes = await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcId}/reject`)
      .set("Authorization", `Bearer ${rejectorToken}`)
      .send({ reason: "الكميات تحتاج إلى مراجعة" });
    expect(rejectRes.status).toBe(200);

    const list = await request(app).get("/api/notifications").set("Authorization", `Bearer ${submitterToken}`);
    expect(list.status).toBe(200);
    const relevant = list.body.notifications.filter((n: { referenceEntityId: string }) => n.referenceEntityId === ipcId);
    expect(relevant).toHaveLength(1);
    expect(relevant[0].type).toBe("ipc.rejected");
    expect(relevant[0].referenceEntityType).toBe("ipc");
    expect(relevant[0].message).toContain(String(ipcNumber));
    expect(relevant[0].message).toContain("الكميات تحتاج إلى مراجعة");
    expect(relevant[0].readAt).toBeNull();
  });

  it("the rejecting user (not the submitter) receives no notification for their own action", async () => {
    const { projectId, ipcId } = await setupSubmittedIpc();
    await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcId}/reject`)
      .set("Authorization", `Bearer ${rejectorToken}`)
      .send({ reason: "test" });

    const list = await request(app).get("/api/notifications").set("Authorization", `Bearer ${rejectorToken}`);
    const relevant = list.body.notifications.filter((n: { referenceEntityId: string }) => n.referenceEntityId === ipcId);
    expect(relevant).toHaveLength(0);
  });

  it("tenant isolation: a user in a different company cannot see this notification", async () => {
    const { projectId, ipcId } = await setupSubmittedIpc();
    await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcId}/reject`)
      .set("Authorization", `Bearer ${rejectorToken}`)
      .send({ reason: "test" });

    const list = await request(app).get("/api/notifications").set("Authorization", `Bearer ${companyBToken}`);
    expect(list.status).toBe(200);
    const relevant = list.body.notifications.filter((n: { referenceEntityId: string }) => n.referenceEntityId === ipcId);
    expect(relevant).toHaveLength(0);
  });

  it("unread count reflects the new notification", async () => {
    const { projectId, ipcId } = await setupSubmittedIpc();

    const before = await request(app).get("/api/notifications/unread-count").set("Authorization", `Bearer ${submitterToken}`);
    const beforeCount = before.body.count as number;

    await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcId}/reject`)
      .set("Authorization", `Bearer ${rejectorToken}`)
      .send({ reason: "test" });

    const after = await request(app).get("/api/notifications/unread-count").set("Authorization", `Bearer ${submitterToken}`);
    expect(after.body.count).toBe(beforeCount + 1);
  });

  it("duplicate business operations do not create duplicate notifications: rejecting an already-rejected IPC is blocked (409) and creates nothing new", async () => {
    const { projectId, ipcId } = await setupSubmittedIpc();

    const first = await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcId}/reject`)
      .set("Authorization", `Bearer ${rejectorToken}`)
      .send({ reason: "first rejection" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcId}/reject`)
      .set("Authorization", `Bearer ${rejectorToken}`)
      .send({ reason: "second rejection attempt" });
    expect(second.status).toBe(409);

    const list = await request(app).get("/api/notifications").set("Authorization", `Bearer ${submitterToken}`);
    const relevant = list.body.notifications.filter((n: { referenceEntityId: string }) => n.referenceEntityId === ipcId);
    expect(relevant).toHaveLength(1);
  });

  it("notification creation does not break the underlying transaction — the IPC status change and audit event both still commit", async () => {
    const { projectId, ipcId } = await setupSubmittedIpc();
    const rejectRes = await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcId}/reject`)
      .set("Authorization", `Bearer ${rejectorToken}`)
      .send({ reason: "test" });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe("rejected");

    const [row] = await db.select().from(ipcs).where(eq(ipcs.id, ipcId));
    expect(row.status).toBe("rejected");
    expect(row.rejectionReason).toBe("test");

    const auditRes = await request(app)
      .get(`/api/audit-events?entityType=ipc&limit=100`)
      .set("Authorization", `Bearer ${rejectorToken}`);
    const rejectedEvent = auditRes.body.events.find(
      (e: { action: string; entityId: string }) => e.action === "ipc.rejected" && e.entityId === ipcId,
    );
    expect(rejectedEvent).toBeTruthy();
  });
});
