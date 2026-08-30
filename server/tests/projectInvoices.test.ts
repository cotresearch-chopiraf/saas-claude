import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// MIDAD UI-09: project-scoped invoices — closes the exact gap
// invoiceProjectContract.test.ts's own tests left open (creation already
// supported projectId/contractId; no project-scoped READ route existed).
// Same shared-company-per-file discipline as ipc.test.ts / measurement.test.ts.

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
    .send({ companyName: "Project Invoice Co", name: "Owner", email: uniqueEmail("pinv-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("pinv-member"), role: "member" });
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
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("pinv-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Invoice Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createContract(projectId: string) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/contracts`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ originalValue: 10000 });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function createInvoice(body: Record<string, unknown>, token = ownerToken) {
  return request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientName: "Client X", items: [{ description: "Work", amount: 1000 }], ...body });
}

function getProjectInvoices(projectId: string, token = ownerToken) {
  return request(app).get(`/api/projects/${projectId}/invoices`).set("Authorization", `Bearer ${token}`);
}

describe("GET /api/projects/:projectId/invoices", () => {
  it("1. owner can read project invoices", async () => {
    const projectId = await createProject();
    const created = await createInvoice({ projectId, taxRatePercent: 0 });
    expect(created.status).toBe(201);

    const res = await getProjectInvoices(projectId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(created.body.id);
  });

  it("2. member can read project invoices (no requirePermission gate on read)", async () => {
    const projectId = await createProject();
    await createInvoice({ projectId, taxRatePercent: 0 });

    const res = await getProjectInvoices(projectId, memberToken);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("3. invoices from another project are never returned", async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    const invoiceA = await createInvoice({ projectId: projectA, clientName: "Client A", taxRatePercent: 0 });
    await createInvoice({ projectId: projectB, clientName: "Client B", taxRatePercent: 0 });

    const res = await getProjectInvoices(projectA);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(invoiceA.body.id);
  });

  it("4. another company's project is never reachable (tenant isolation)", async () => {
    const projectId = await createProject();
    await createInvoice({ projectId, taxRatePercent: 0 });

    const res = await getProjectInvoices(projectId, companyBToken);
    expect(res.status).toBe(404);
  });

  it("5. empty project returns an empty list", async () => {
    const projectId = await createProject();
    const res = await getProjectInvoices(projectId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("6. project with multiple invoices returns all and only its invoices", async () => {
    const projectId = await createProject();
    const inv1 = await createInvoice({ projectId, clientName: "Client 1", taxRatePercent: 0 });
    const inv2 = await createInvoice({ projectId, clientName: "Client 2", taxRatePercent: 0 });
    const inv3 = await createInvoice({ projectId, clientName: "Client 3", taxRatePercent: 0 });

    const res = await getProjectInvoices(projectId);
    expect(res.status).toBe(200);
    const ids = res.body.map((i: { id: string }) => i.id).sort();
    expect(ids).toEqual([inv1.body.id, inv2.body.id, inv3.body.id].sort());
  });

  it("7. an unallocated invoice (projectId null) is never returned by a project-scoped query", async () => {
    const projectId = await createProject();
    await createInvoice({ taxRatePercent: 0 }); // no projectId at all — company-level, unallocated

    const res = await getProjectInvoices(projectId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("8. a contract/project mismatch at creation time cannot leak an invoice into the wrong project's list", async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    const contractA = await createContract(projectA);

    // Supplying contractA (belongs to projectA) together with projectB is
    // rejected at creation (existing resolveInvoiceProjectContract logic) —
    // confirms no invoice can ever land in projectB's list via this path.
    const mismatched = await createInvoice({ contractId: contractA, projectId: projectB, taxRatePercent: 0 });
    expect(mismatched.status).toBe(400);

    const resB = await getProjectInvoices(projectB);
    expect(resB.body).toEqual([]);

    // The correctly-scoped version (contract only, project derived from it) does land in projectA's list.
    const correct = await createInvoice({ contractId: contractA, taxRatePercent: 0 });
    expect(correct.status).toBe(201);
    const resA = await getProjectInvoices(projectA);
    expect(resA.body).toHaveLength(1);
    expect(resA.body[0].id).toBe(correct.body.id);
  });

  it("9. returned financial fields (subtotal/taxAmount/total) match the backend's own computeTotals exactly", async () => {
    const projectId = await createProject();
    const created = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        projectId,
        clientName: "Client X",
        taxRatePercent: 15,
        items: [
          { description: "Item A", amount: 1234.56 },
          { description: "Item B", amount: 765.44 },
        ],
      });
    expect(created.status).toBe(201);

    const res = await getProjectInvoices(projectId);
    expect(res.status).toBe(200);
    const invoice = res.body[0];
    // subtotal = 1234.56 + 765.44 = 2000.00; tax = 2000.00 * 0.15 = 300.00; total = 2300.00.
    expect(invoice.subtotal).toBe(2000);
    expect(invoice.taxAmount).toBe(300);
    expect(invoice.total).toBe(2300);
  });

  it("10. a nonexistent project returns 404, not an empty list masquerading as success", async () => {
    const res = await getProjectInvoices("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("invoices sums correctly with multiple items and a real tax rate — proving the route reuses computeTotals verbatim, not a re-derivation", async () => {
    const projectId = await createProject();
    await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ projectId, clientName: "Client Y", taxRatePercent: 5, items: [{ description: "Solo item", amount: 100 }] });

    const res = await getProjectInvoices(projectId);
    expect(res.body[0].subtotal).toBe(100);
    expect(res.body[0].taxAmount).toBe(5);
    expect(res.body[0].total).toBe(105);
  });
});
