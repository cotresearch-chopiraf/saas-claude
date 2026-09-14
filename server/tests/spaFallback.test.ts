import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { buildApp } from "../src/app.js";

// A1 remediation — regression coverage for the single-origin deployment
// change in app.ts: /api/*, /uploads/*, and the SPA fallback must stay
// correctly isolated regardless of future route-order edits to app.ts.
// This is the one property this whole change depends on, so it's asserted
// directly against a real buildApp() instance via supertest, exactly like
// every other route-level test in this suite — not just inspected by eye.
//
// clientDistDir mirrors app.ts's own path.resolve(process.cwd(),
// "../client/dist") resolution exactly, so this test exercises the real
// runtime path, not a stand-in. The real client build may not exist yet at
// the point this suite runs (CI's own pipeline runs server tests before
// the build step that produces client/dist — see .github/workflows/ci.yml),
// so a minimal, deterministic fixture is created here if missing, and
// removed again afterward only if this test created it — a real local or
// CI-produced build is never touched or deleted.
const clientDistDir = path.resolve(process.cwd(), "../client/dist");
const indexHtmlPath = path.join(clientDistDir, "index.html");
const assetPath = path.join(clientDistDir, "assets", "spa-fallback-test.js");
const fixtureIndexHtml = "<!doctype html><html><body><div id=\"root\">midad-spa-fallback-fixture</div></body></html>";

let createdClientDistDir = false;
let createdIndexHtml = false;
let createdAssetsDir = false;

beforeAll(() => {
  createdClientDistDir = !fs.existsSync(clientDistDir);
  fs.mkdirSync(clientDistDir, { recursive: true });

  createdIndexHtml = !fs.existsSync(indexHtmlPath);
  if (createdIndexHtml) fs.writeFileSync(indexHtmlPath, fixtureIndexHtml);

  createdAssetsDir = !fs.existsSync(path.dirname(assetPath));
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  if (!fs.existsSync(assetPath)) fs.writeFileSync(assetPath, "// spa fallback test asset\n");
});

afterAll(() => {
  // Only remove exactly what this test created — never a real build.
  if (fs.existsSync(assetPath)) fs.rmSync(assetPath, { force: true });
  if (createdIndexHtml && fs.existsSync(indexHtmlPath)) fs.rmSync(indexHtmlPath, { force: true });
  if (createdAssetsDir) fs.rmSync(path.dirname(assetPath), { recursive: true, force: true });
  if (createdClientDistDir) fs.rmSync(clientDistDir, { recursive: true, force: true });
});

const app = buildApp();

describe("Single-origin deployment: static frontend + SPA fallback", () => {
  it("GET / serves the built client (SPA shell), not a 404", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it("a real static asset under /assets is served successfully", async () => {
    const res = await request(app).get("/assets/spa-fallback-test.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("spa fallback test asset");
  });

  it("a BrowserRouter deep link (e.g. /projects/test/boq) returns the SPA shell, not a 404", async () => {
    const res = await request(app).get("/projects/test/boq");
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it("GET /api/health/live still works, unaffected by static/SPA wiring", async () => {
    const res = await request(app).get("/api/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /api/health/ready still works, unaffected by static/SPA wiring", async () => {
    const res = await request(app).get("/api/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("an unmatched /api/* route remains an API 404, never the SPA shell — this is the property most at risk from a future route-order change", async () => {
    const res = await request(app).get("/api/this-route-does-not-exist");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('id="root"');
  });

  it("a bare /api request (no further path) is not swallowed by the SPA fallback either", async () => {
    const res = await request(app).get("/api");
    expect(res.status).not.toBe(200);
    expect(res.text ?? "").not.toContain('id="root"');
  });

  it("/uploads/* behavior is unaffected — a missing upload 404s, never the SPA shell", async () => {
    const res = await request(app).get("/uploads/this-file-does-not-exist.png");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('id="root"');
  });
});
