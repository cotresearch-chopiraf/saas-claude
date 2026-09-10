import { Router, type Request, type Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { clientProjectAccess, projects } from "../db/schema.js";
import { requireClientProjectAccess } from "../middleware/requireClientProjectAccess.js";

// MIDAD Phase B1/B2 — the only Client Portal data surface these two
// slices ship: the minimal, safe project identity a granted project's
// access confirms, plus (B2) the small set of additional fields the
// dashboard/detail view needs for a client to recognize and understand
// their own project — never progress, documents, IPC, invoices, or any
// financial field. Every field below is already exposed to internal
// company members on GET /api/projects; nothing here is a new
// disclosure, only a narrower audience for a subset of already-non-
// sensitive fields. clientName/address are included even when null
// (never omitted) — same "always-present, possibly-null field" shape
// every other API response in this codebase already uses, so the client
// only has to guard for null, not for a missing key.
//
// clientPortalAuth is applied at the app.ts mount site (same convention
// platformAuth/platformOrganizationsRouter already uses), not inside this
// file — req.clientPortalUserId is expected to already be set by the time
// any handler below runs.
export const clientPortalProjectsRouter = Router();

interface MinimalProject {
  id: string;
  name: string;
  status: string;
  startDate: string | null;
  clientName: string | null;
  address: string | null;
}

function toMinimalProject(p: typeof projects.$inferSelect): MinimalProject {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    startDate: p.startDate,
    clientName: p.clientName,
    address: p.address,
  };
}

clientPortalProjectsRouter.get("/", async (req: Request, res: Response) => {
  const grants = await db.query.clientProjectAccess.findMany({
    where: and(eq(clientProjectAccess.clientPortalUserId, req.clientPortalUserId!), isNull(clientProjectAccess.revokedAt)),
  });
  if (grants.length === 0) return res.json([]);

  const projectIds = new Set(grants.map((g) => g.projectId));
  const rows = await db.query.projects.findMany({
    where: (p, { inArray }) => inArray(p.id, Array.from(projectIds)),
  });
  res.json(rows.map(toMinimalProject));
});

clientPortalProjectsRouter.get(
  "/:projectId",
  requireClientProjectAccess,
  async (req: Request<{ projectId: string }>, res: Response) => {
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.clientPortalGrantCompanyId!)),
    });
    if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
    res.json(toMinimalProject(project));
  },
);
