import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// Real code path, not a mock of the app: only the outbound "email" (which
// normally just console.logs the invite link) is intercepted, so the test
// can read the raw invite token the same way a real inbox would.
vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function extractToken(mailBody: string): string {
  const match = mailBody.match(/token=([a-f0-9]{64})/);
  if (!match) throw new Error(`no token found in mail body: ${mailBody}`);
  return match[1];
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

// One owner + one member account is registered ONCE for this whole file
// (register + accept-invite are both under the /api/auth rate limiter,
// which — realistically — a real user only hits when actually
// registering/logging in, not once per assertion) and reused across every
// test below; each test creates its own fresh project/invoice/quote so
// tests still don't interfere with each other's data.
let ownerToken: string;
let memberToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Authz Co", name: "Owner", email: uniqueEmail("owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("member"), role: "member" });
  expect(inviteRes.status).toBe(201);

  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = extractToken(mailCall[2] as string);

  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member User", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberToken = acceptRes.body.token;
});

async function setupProjectAndChangeOrder() {
  const projectRes = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: `Authz Project ${Math.random()}`, budgetTotal: 1000 });
  const coRes = await request(app)
    .post(`/api/projects/${projectRes.body.id}/change-orders`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ title: "CO", amountDelta: 100 });
  return { projectId: projectRes.body.id as string, changeOrderId: coRes.body.id as string };
}

async function setupInvoice() {
  const res = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ clientName: "Authz Client", items: [{ description: "x", amount: 100 }] });
  return res.body.id as string;
}

async function setupQuote() {
  const res = await request(app)
    .post("/api/quotes")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ clientName: "Authz Client", projectName: "Authz Job", items: [{ description: "x", amount: 100 }] });
  return res.body.id as string;
}

// UI-Foundation: the frontend cannot render owner-only actions without
// knowing the caller's own role — /auth/me is the one place that role is
// now exposed. Backend authorization itself is unchanged: every mutation
// route still independently re-checks the role from the DB via
// requirePermission, proven by the describe block below this one.
describe("/auth/me — role", () => {
  it("an owner's /auth/me response includes role: owner", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("owner");
  });

  it("a member's /auth/me response includes role: member", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("member");
  });

  it("every existing /auth/me field remains intact", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBeTruthy();
    expect(res.body.user.name).toBe("Owner");
    expect(res.body.user.email).toMatch(/@test\.com$/);
    expect(res.body.company.id).toBeTruthy();
    expect(res.body.company.name).toBe("Authz Co");
  });

  it("unauthenticated /auth/me is rejected exactly as before", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });
});

describe("server-side authorization: member cannot perform owner-only financial/destructive actions", () => {
  it("member cannot approve a change order, and the budget is left untouched", async () => {
    const { projectId, changeOrderId } = await setupProjectAndChangeOrder();

    const res = await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${changeOrderId}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ status: "approved" });
    expect(res.status).toBe(403);

    const project = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(project.body.budgetTotal)).toBe(1000);
  });

  it("owner CAN approve a change order", async () => {
    const { projectId, changeOrderId } = await setupProjectAndChangeOrder();

    const res = await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${changeOrderId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "approved" });
    expect(res.status).toBe(200);
  });

  it("member cannot delete a project, and it still exists afterward", async () => {
    const { projectId } = await setupProjectAndChangeOrder();

    const res = await request(app).delete(`/api/projects/${projectId}`).set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(403);

    const stillThere = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(stillThere.status).toBe(200);
  });

  it("owner CAN delete a project", async () => {
    const { projectId } = await setupProjectAndChangeOrder();

    const res = await request(app).delete(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(204);
  });

  it("member cannot send an invoice", async () => {
    const invoiceId = await setupInvoice();

    const res = await request(app).patch(`/api/invoices/${invoiceId}/send`).set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });

  it("owner CAN send an invoice", async () => {
    const invoiceId = await setupInvoice();

    const res = await request(app).patch(`/api/invoices/${invoiceId}/send`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
  });

  it("member cannot mark a sent invoice paid", async () => {
    const invoiceId = await setupInvoice();
    await request(app).patch(`/api/invoices/${invoiceId}/send`).set("Authorization", `Bearer ${ownerToken}`);

    const res = await request(app).patch(`/api/invoices/${invoiceId}/mark-paid`).set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });

  it("owner CAN mark a sent invoice paid", async () => {
    const invoiceId = await setupInvoice();
    await request(app).patch(`/api/invoices/${invoiceId}/send`).set("Authorization", `Bearer ${ownerToken}`);

    const res = await request(app).patch(`/api/invoices/${invoiceId}/mark-paid`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
  });

  it("member cannot send a quote", async () => {
    const quoteId = await setupQuote();

    const res = await request(app).patch(`/api/quotes/${quoteId}/send`).set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });

  it("owner CAN send a quote", async () => {
    const quoteId = await setupQuote();

    const res = await request(app).patch(`/api/quotes/${quoteId}/send`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
  });

  it("member cannot self-escalate by inviting a new owner", async () => {
    const res = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ email: uniqueEmail("escalate"), role: "owner" });
    expect(res.status).toBe(403);
  });

  it("a denied action never returns a 5xx — an unauthorized-role response must be a real 403, not a crash", async () => {
    const { projectId, changeOrderId } = await setupProjectAndChangeOrder();

    const res = await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${changeOrderId}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ status: "approved" });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("member-appropriate actions (creating a project) are unaffected by this remediation", async () => {
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Member-created project" });
    expect(res.status).toBe(201);
  });
});
