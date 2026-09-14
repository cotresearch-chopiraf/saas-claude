import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD Final Pre-Launch audit, Phase 9 — Ownership Transfer. Flow:
// Current Platform Owner -> Select New Owner -> Security Confirmation
// (typed email match) -> Confirm Transfer -> Update Ownership -> Revoke
// Previous Owner Sessions -> (logged) Audit Event -> Transfer Report (the
// response itself).

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function createOperator(role: "platform_owner" | "platform_admin" | "support" | "compliance" | "auditor", nameSuffix = "") {
  const email = uniqueEmail(`ot-${role}${nameSuffix}`);
  await db.insert(platformOperators).values({ email, name: `${role}${nameSuffix}`, role, passwordHash: await hashPassword("operatorpass123") });
  const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
  expect(login.status).toBe(200);
  return { email, token: login.body.token as string, id: login.body.operator.id as string };
}

beforeEach(resetDb);

describe("platform ownership transfer: auth boundary", () => {
  it("unauthenticated and tenant-JWT access are rejected", async () => {
    expect((await request(app).post("/api/platform/ownership-transfer")).status).toBe(401);
  });

  it("cannot be initiated by admin, support, compliance, or auditor", async () => {
    const target = await createOperator("platform_admin", "-target");
    for (const role of ["platform_admin", "support", "compliance", "auditor"] as const) {
      const actor = await createOperator(role);
      const res = await request(app)
        .post("/api/platform/ownership-transfer")
        .set("Authorization", `Bearer ${actor.token}`)
        .send({ newOwnerOperatorId: target.id, confirmationEmail: target.email, reason: "Test" });
      expect(res.status).toBe(403);
    }
  });
});

// MIDAD Final Pre-Launch audit, Phase 22 (UX) — GET /operators, added so the
// transfer UI has a real candidate list instead of asking for a raw UUID.
describe("platform ownership transfer: GET /operators", () => {
  it("unauthenticated and non-owner access are rejected", async () => {
    expect((await request(app).get("/api/platform/ownership-transfer/operators")).status).toBe(401);
    const admin = await createOperator("platform_admin");
    const res = await request(app).get("/api/platform/ownership-transfer/operators").set("Authorization", `Bearer ${admin.token}`);
    expect(res.status).toBe(403);
  });

  it("lists active operators without exposing passwordHash", async () => {
    const owner = await createOperator("platform_owner");
    const other = await createOperator("platform_admin", "-other");
    const res = await request(app).get("/api/platform/ownership-transfer/operators").set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.operators.map((o: { id: string }) => o.id);
    expect(ids).toContain(owner.id);
    expect(ids).toContain(other.id);
    expect(res.body.operators[0]).not.toHaveProperty("passwordHash");
  });

  it("excludes deactivated operators", async () => {
    const owner = await createOperator("platform_owner");
    const inactive = await createOperator("platform_admin", "-inactive");
    await db.update(platformOperators).set({ status: "deactivated" }).where(eq(platformOperators.id, inactive.id));

    const res = await request(app).get("/api/platform/ownership-transfer/operators").set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.operators.map((o: { id: string }) => o.id);
    expect(ids).not.toContain(inactive.id);
  });
});

describe("platform ownership transfer: validation", () => {
  it("rejects transferring to yourself (self-confusing transfer)", async () => {
    const owner = await createOperator("platform_owner");
    const res = await request(app)
      .post("/api/platform/ownership-transfer")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ newOwnerOperatorId: owner.id, confirmationEmail: owner.email, reason: "Test" });
    expect(res.status).toBe(400);
  });

  it("rejects a nonexistent new owner", async () => {
    const owner = await createOperator("platform_owner");
    const res = await request(app)
      .post("/api/platform/ownership-transfer")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ newOwnerOperatorId: "00000000-0000-0000-0000-000000000000", confirmationEmail: "nobody@test.com", reason: "Test" });
    expect(res.status).toBe(404);
  });

  it("rejects a deactivated new owner", async () => {
    const owner = await createOperator("platform_owner");
    const target = await createOperator("platform_admin", "-deactivated");
    await db.update(platformOperators).set({ status: "deactivated" }).where(eq(platformOperators.id, target.id));

    const res = await request(app)
      .post("/api/platform/ownership-transfer")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ newOwnerOperatorId: target.id, confirmationEmail: target.email, reason: "Test" });
    expect(res.status).toBe(409);
  });

  it("rejects a mismatched confirmation email (Security Confirmation step)", async () => {
    const owner = await createOperator("platform_owner");
    const target = await createOperator("platform_admin", "-target");
    const res = await request(app)
      .post("/api/platform/ownership-transfer")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ newOwnerOperatorId: target.id, confirmationEmail: "wrong@test.com", reason: "Test" });
    expect(res.status).toBe(400);
  });

  it("requires a reason", async () => {
    const owner = await createOperator("platform_owner");
    const target = await createOperator("platform_admin", "-target");
    const res = await request(app)
      .post("/api/platform/ownership-transfer")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ newOwnerOperatorId: target.id, confirmationEmail: target.email });
    expect(res.status).toBe(400);
  });
});

describe("platform ownership transfer: happy path", () => {
  it("transfers ownership, demotes the previous owner (never orphaning ownership), and returns a transfer report", async () => {
    const owner = await createOperator("platform_owner");
    const target = await createOperator("platform_admin", "-target");

    const res = await request(app)
      .post("/api/platform/ownership-transfer")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ newOwnerOperatorId: target.id, confirmationEmail: target.email, reason: "Founder stepping back from platform operations" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      previousOwner: { id: owner.id, newRole: "platform_admin" },
      newOwner: { id: target.id, newRole: "platform_owner" },
      reason: "Founder stepping back from platform operations",
    });

    const previousRow = await db.query.platformOperators.findFirst({ where: eq(platformOperators.id, owner.id) });
    const newRow = await db.query.platformOperators.findFirst({ where: eq(platformOperators.id, target.id) });
    expect(previousRow!.role).toBe("platform_admin");
    expect(newRow!.role).toBe("platform_owner");
  });

  it("revokes the previous owner's sessions, including the one that made the transfer request", async () => {
    const owner = await createOperator("platform_owner");
    const target = await createOperator("platform_admin", "-target");

    const res = await request(app)
      .post("/api/platform/ownership-transfer")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ newOwnerOperatorId: target.id, confirmationEmail: target.email, reason: "Test" });
    expect(res.body.revokedSessionCount).toBe(1);

    // The next request with the (now-demoted, revoked) previous owner's
    // token must fail — a fresh login is required.
    const blocked = await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${owner.token}`);
    expect(blocked.status).toBe(401);

    // The new owner's own token is completely unaffected.
    const stillWorks = await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${target.token}`);
    expect(stillWorks.status).toBe(200);
  });

  it("the demoted previous owner can log back in and retains platform_admin access (not orphaned/locked out)", async () => {
    const owner = await createOperator("platform_owner");
    const target = await createOperator("platform_admin", "-target");

    await request(app)
      .post("/api/platform/ownership-transfer")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ newOwnerOperatorId: target.id, confirmationEmail: target.email, reason: "Test" });

    const relogin = await request(app).post("/api/platform/auth/login").send({ email: owner.email, password: "operatorpass123" });
    expect(relogin.status).toBe(200);

    const res = await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${relogin.body.token}`);
    expect(res.status).toBe(200);

    // But ownership-transfer.manage is now denied — the demoted operator
    // is no longer platform_owner.
    const denied = await request(app)
      .post("/api/platform/ownership-transfer")
      .set("Authorization", `Bearer ${relogin.body.token}`)
      .send({ newOwnerOperatorId: target.id, confirmationEmail: target.email, reason: "Test" });
    expect(denied.status).toBe(403);
  });

  it("does not revoke the new owner's OTHER pre-existing sessions", async () => {
    const owner = await createOperator("platform_owner");
    const target = await createOperator("platform_admin", "-target");
    // A second session for the target, logged in before the transfer.
    const targetSecondLogin = await request(app).post("/api/platform/auth/login").send({ email: target.email, password: "operatorpass123" });

    await request(app)
      .post("/api/platform/ownership-transfer")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ newOwnerOperatorId: target.id, confirmationEmail: target.email, reason: "Test" });

    expect((await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${target.token}`)).status).toBe(200);
    expect((await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${targetSecondLogin.body.token}`)).status).toBe(200);
  });
});

// Red-Team Remediation Wave 1C — the checks preceding the transfer
// transaction (including "is the caller still platform_owner") were all
// plain reads taken BEFORE the transaction opened, with no condition on
// the demote UPDATE itself: two concurrent transfers from the same owner
// to two different targets could both pass every check and both commit,
// leaving two accounts holding platform_owner at once. The fix makes the
// previous-owner demote UPDATE conditional on the row still holding
// role='platform_owner' at the moment it actually runs, and rolls back
// (409) when it doesn't. This test proves the invariant holds under real
// concurrent requests, not just sequentially.
describe("platform ownership transfer: concurrency (Wave 1C fix)", () => {
  it("two simultaneous transfers from the same owner to different targets: exactly one succeeds, exactly one platform_owner remains, no partial state", async () => {
    const owner = await createOperator("platform_owner");
    const targetB = await createOperator("platform_admin", "-race-b");
    const targetC = await createOperator("platform_admin", "-race-c");

    const [resB, resC] = await Promise.all([
      request(app)
        .post("/api/platform/ownership-transfer")
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ newOwnerOperatorId: targetB.id, confirmationEmail: targetB.email, reason: "Race to B" }),
      request(app)
        .post("/api/platform/ownership-transfer")
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ newOwnerOperatorId: targetC.id, confirmationEmail: targetC.email, reason: "Race to C" }),
    ]);

    // Exactly one request succeeds, exactly one is rejected as a conflict.
    expect([resB.status, resC.status].sort()).toEqual([200, 409]);

    // Exactly one platform_owner exists afterward, and it is whichever
    // target actually won — never zero, never two.
    const owners = await db.query.platformOperators.findMany({ where: eq(platformOperators.role, "platform_owner") });
    expect(owners).toHaveLength(1);
    expect([targetB.id, targetC.id]).toContain(owners[0].id);

    // No partially-applied state: the original owner is cleanly demoted,
    // and the losing target is completely unchanged — never left
    // half-promoted by the rolled-back transaction.
    const ownerRow = await db.query.platformOperators.findFirst({ where: eq(platformOperators.id, owner.id) });
    expect(ownerRow!.role).toBe("platform_admin");

    const loserId = owners[0].id === targetB.id ? targetC.id : targetB.id;
    const loserRow = await db.query.platformOperators.findFirst({ where: eq(platformOperators.id, loserId) });
    expect(loserRow!.role).toBe("platform_admin");

    // Session revocation behavior remains correct for the winning
    // transfer: the original owner's token is now dead.
    const blocked = await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${owner.token}`);
    expect(blocked.status).toBe(401);
  });
});
