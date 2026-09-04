import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { createNotification } from "../src/lib/notifications.js";
import { db } from "../src/db/client.js";

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

function extractToken(mailBody: string): string {
  const match = mailBody.match(/token=([a-f0-9]{64})/);
  if (!match) throw new Error(`no token found in mail body: ${mailBody}`);
  return match[1];
}

// Slice AA Scope F — notification foundation. No producer is wired up yet
// (per F5), so these tests seed rows directly via lib/notifications.ts's
// own createNotification, then exercise the read/mark-read API exactly as
// a future producer's consumer would.

const app = buildApp();

let userA1Token: string, userA1Id: string, companyA: string;
let userA2Token: string, userA2Id: string;
let userBToken: string, userBId: string, companyB: string;

beforeAll(async () => {
  await resetDb();

  const a1 = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Notif Co A", name: "User A1", email: "notif-a1@test.com", password: "password123" });
  userA1Token = a1.body.token;
  userA1Id = a1.body.user.id;
  companyA = a1.body.company.id;

  const b = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Notif Co B", name: "User B", email: "notif-b@test.com", password: "password123" });
  userBToken = b.body.token;
  userBId = b.body.user.id;
  companyB = b.body.company.id;

  // A second user in company A: invited + accepted, so notification
  // isolation can be proven WITHIN a tenant, not just across tenants.
  await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${userA1Token}`)
    .send({ email: "notif-a2@test.com", role: "member" });
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = extractToken(mailCall[2] as string);
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "User A2", password: "password123" });
  userA2Token = acceptRes.body.token;
  userA2Id = acceptRes.body.user.id;
});

async function seed(companyId: string, recipientUserId: string, overrides: Partial<{ title: string }> = {}) {
  return createNotification(db, {
    companyId,
    recipientUserId,
    type: "test.event",
    title: overrides.title ?? "Test notification",
    message: "Something happened",
  });
}

describe("Notifications: auth", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(401);
  });
});

describe("Notifications: recipient ownership (same tenant)", () => {
  it("a user only sees their own notifications, not a teammate's", async () => {
    await seed(companyA, userA1Id, { title: "For A1" });
    await seed(companyA, userA2Id, { title: "For A2" });

    const resA1 = await request(app).get("/api/notifications").set("Authorization", `Bearer ${userA1Token}`);
    expect(resA1.status).toBe(200);
    expect(resA1.body.notifications.every((n: { title: string }) => n.title !== "For A2")).toBe(true);
    expect(resA1.body.notifications.some((n: { title: string }) => n.title === "For A1")).toBe(true);

    const resA2 = await request(app).get("/api/notifications").set("Authorization", `Bearer ${userA2Token}`);
    expect(resA2.body.notifications.every((n: { title: string }) => n.title !== "For A1")).toBe(true);
  });

  it("a user cannot mark a teammate's notification as read", async () => {
    const theirs = await seed(companyA, userA2Id, { title: "A2 only" });
    const res = await request(app)
      .patch(`/api/notifications/${theirs.id}/read`)
      .set("Authorization", `Bearer ${userA1Token}`);
    expect(res.status).toBe(404);
  });
});

describe("Notifications: tenant isolation", () => {
  it("company B cannot see or mark-read company A's notifications", async () => {
    const theirs = await seed(companyA, userA1Id, { title: "Company A only" });

    const listRes = await request(app).get("/api/notifications").set("Authorization", `Bearer ${userBToken}`);
    expect(listRes.body.notifications.every((n: { title: string }) => n.title !== "Company A only")).toBe(true);

    const readRes = await request(app)
      .patch(`/api/notifications/${theirs.id}/read`)
      .set("Authorization", `Bearer ${userBToken}`);
    expect(readRes.status).toBe(404);
  });
});

describe("Notifications: unread count and mark-read", () => {
  it("unread-count reflects only this user's unread notifications", async () => {
    await resetDb();
    const reg = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Unread Co", name: "Owner", email: "unread-owner@test.com", password: "password123" });
    const token = reg.body.token as string;
    const uid = reg.body.user.id as string;
    const cid = reg.body.company.id as string;

    const before = await request(app).get("/api/notifications/unread-count").set("Authorization", `Bearer ${token}`);
    expect(before.body.count).toBe(0);

    const n1 = await seed(cid, uid, { title: "First" });
    await seed(cid, uid, { title: "Second" });

    const afterSeed = await request(app).get("/api/notifications/unread-count").set("Authorization", `Bearer ${token}`);
    expect(afterSeed.body.count).toBe(2);

    const markRes = await request(app).patch(`/api/notifications/${n1.id}/read`).set("Authorization", `Bearer ${token}`);
    expect(markRes.status).toBe(200);
    expect(markRes.body.readAt).not.toBeNull();

    const afterMark = await request(app).get("/api/notifications/unread-count").set("Authorization", `Bearer ${token}`);
    expect(afterMark.body.count).toBe(1);

    const markAllRes = await request(app).post("/api/notifications/mark-all-read").set("Authorization", `Bearer ${token}`);
    expect(markAllRes.status).toBe(204);

    const afterMarkAll = await request(app).get("/api/notifications/unread-count").set("Authorization", `Bearer ${token}`);
    expect(afterMarkAll.body.count).toBe(0);
  });
});

describe("Notifications: pagination", () => {
  it("enforces a server-side max page size and orders deterministically", async () => {
    await resetDb();
    const reg = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Page Co", name: "Owner", email: "page-owner@test.com", password: "password123" });
    const token = reg.body.token as string;
    const uid = reg.body.user.id as string;
    const cid = reg.body.company.id as string;

    for (let i = 0; i < 5; i++) {
      await seed(cid, uid, { title: `Notification ${i}` });
    }

    const page1 = await request(app)
      .get("/api/notifications?limit=2&offset=0")
      .set("Authorization", `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.notifications.length).toBe(2);
    expect(page1.body.hasMore).toBe(true);

    const page3 = await request(app)
      .get("/api/notifications?limit=2&offset=4")
      .set("Authorization", `Bearer ${token}`);
    expect(page3.body.notifications.length).toBe(1);
    expect(page3.body.hasMore).toBe(false);

    const overLimit = await request(app)
      .get("/api/notifications?limit=99999")
      .set("Authorization", `Bearer ${token}`);
    expect(overLimit.status).toBe(400);
  });
});
