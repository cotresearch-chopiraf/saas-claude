import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";

// MIDAD Phase B — Observability Foundation. Health endpoints, request-id
// correlation, structured request logging (with safe auth context, never
// secrets), and the machine-readable error-code envelope layered onto the
// existing {error:"..."} contract without any route needing to change.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;
let ownerPassword: string;
let ownerEmail: string;
let memberToken: string;

beforeAll(async () => {
  await resetDb();

  ownerEmail = uniqueEmail("obs-owner");
  ownerPassword = "password123";
  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Observability Co", name: "Owner", email: ownerEmail, password: ownerPassword });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("obs-member"), role: "member" });
  expect(inviteRes.status).toBe(201);
  const { sendMail } = await import("../src/lib/mailer.js");
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberToken = acceptRes.body.token;
});

describe("health endpoints", () => {
  it("1. GET /api/health/live succeeds without authentication and exposes no internals", async () => {
    const res = await request(app).get("/api/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("2. GET /api/health/ready succeeds when the database is available", async () => {
    const res = await request(app).get("/api/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("3. the pre-existing /api/health route is unchanged", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("4. readiness fails safely (503, no connection details) when the database is unavailable", async () => {
    const originalExecute = db.execute.bind(db);
    db.execute = vi.fn().mockRejectedValue(new Error("connection refused at postgres://user:secret@internal-db:5432/prod")) as typeof db.execute;
    try {
      const res = await request(app).get("/api/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("error");
      expect(res.body.code).toBe("SERVICE_UNAVAILABLE");
      expect(JSON.stringify(res.body)).not.toContain("secret");
      expect(JSON.stringify(res.body)).not.toContain("postgres://");
    } finally {
      db.execute = originalExecute;
    }
  });
});

describe("request id correlation", () => {
  it("5. a request id is generated and returned in the response header when none is supplied", async () => {
    const res = await request(app).get("/api/health/live");
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("6. a valid incoming request id is echoed back unchanged", async () => {
    const res = await request(app).get("/api/health/live").set("X-Request-Id", "client-supplied-id-123");
    expect(res.headers["x-request-id"]).toBe("client-supplied-id-123");
  });

  it("7. an unsafe/oversized incoming request id is replaced with a freshly generated one", async () => {
    const res = await request(app).get("/api/health/live").set("X-Request-Id", "a".repeat(500));
    expect(res.headers["x-request-id"]).not.toBe("a".repeat(500));
    expect(res.headers["x-request-id"]!.length).toBeLessThan(200);
  });

  it("8. an error response carries the same request id as the response header", async () => {
    const res = await request(app).get("/api/company/members");
    expect(res.status).toBe(401);
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
  });
});

describe("structured request logging and authentication context", () => {
  it("9. a request's log line carries the request id, and an authenticated request also carries userId/companyId", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await request(app).get("/api/customers").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);

      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      const httpLine = lines.find((l) => l.includes('"http_request"') && l.includes(res.headers["x-request-id"]!));
      expect(httpLine).toBeTruthy();
      const parsed = JSON.parse(httpLine!);
      expect(parsed.requestId).toBe(res.headers["x-request-id"]);
      expect(parsed.status).toBe(200);
      expect(parsed.userId).toBeTruthy();
      expect(parsed.companyId).toBeTruthy();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("10. an unauthenticated request's log line carries the request id but no userId/companyId", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await request(app).get("/api/health/live");
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      const httpLine = lines.find((l) => l.includes('"http_request"') && l.includes(res.headers["x-request-id"]!));
      const parsed = JSON.parse(httpLine!);
      expect(parsed.userId).toBeUndefined();
      expect(parsed.companyId).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("11. no log line during a real login ever contains the raw password or the issued JWT", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await request(app).post("/api/auth/login").send({ email: ownerEmail, password: ownerPassword });
      expect(res.status).toBe(200);
      const token = res.body.token as string;

      const allOutput = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0])).join("\n");
      expect(allOutput).not.toContain(ownerPassword);
      expect(allOutput).not.toContain(token);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe("typed error codes on the existing {error} contract", () => {
  it("12. VALIDATION — a zod rejection keeps its 400 status and existing message, plus a machine-readable code", async () => {
    const res = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.code).toBe("VALIDATION");
    expect(res.body.requestId).toBeTruthy();
  });

  it("13. AUTHENTICATION — a missing token keeps its 401 status and existing message, plus a machine-readable code", async () => {
    const res = await request(app).get("/api/customers");
    expect(res.status).toBe(401);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.code).toBe("AUTHENTICATION");
  });

  it("14. AUTHORIZATION — a member hitting an owner-only route keeps its 403 status and existing message, plus a machine-readable code", async () => {
    const res = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "محاولة عضو" });
    expect(res.status).toBe(403);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.code).toBe("AUTHORIZATION");
  });

  it("15. NOT_FOUND — a nonexistent resource keeps its 404 status and existing message, plus a machine-readable code", async () => {
    const res = await request(app)
      .get("/api/customers/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("16. CONFLICT — an existing business-rule rejection keeps its 409 status and existing message, plus a machine-readable code", async () => {
    const soloRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Solo Owner Obs Co", name: "Solo", email: uniqueEmail("obs-solo"), password: "password123" });
    expect(soloRes.status).toBe(201);
    const res = await request(app)
      .patch(`/api/company/members/${soloRes.body.user.id}`)
      .set("Authorization", `Bearer ${soloRes.body.token}`)
      .send({ status: "deactivated" });
    expect(res.status).toBe(409);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.code).toBe("CONFLICT");
  });

  it("17. INTERNAL — an unexpected failure keeps a safe 500 message, plus a machine-readable code and a request id, without leaking the raw error", async () => {
    const original = db.query.customers.findMany;
    db.query.customers.findMany = vi.fn().mockRejectedValue(new Error("relation \"customers\" leaked-detail")) as typeof db.query.customers.findMany;
    try {
      const res = await request(app).get("/api/customers").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("INTERNAL");
      expect(res.body.requestId).toBeTruthy();
      expect(res.body.error).not.toContain("leaked-detail");
    } finally {
      db.query.customers.findMany = original;
    }
  });

  it("18. a route that already sets its own explicit code is respected, not overridden by status-derived guessing", async () => {
    const express = (await import("express")).default;
    const { errorEnvelopeMiddleware } = await import("../src/middleware/errorEnvelope.js");
    const { requestIdMiddleware } = await import("../src/middleware/requestId.js");
    const miniApp = express();
    miniApp.use(requestIdMiddleware);
    miniApp.use(errorEnvelopeMiddleware);
    miniApp.get("/explicit-code", (_req, res) => {
      res.status(409).json({ error: "تعارض مخصص", code: "CUSTOM_CONFLICT" });
    });
    const res = await request(miniApp).get("/explicit-code");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CUSTOM_CONFLICT");
    expect(res.body.requestId).toBeTruthy();
  });

  it("19. success responses are never touched by the error envelope", async () => {
    const res = await request(app).get("/api/customers").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(res.body.requestId).toBeUndefined();
  });
});
