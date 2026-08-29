import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";

export const projectsRouter = Router();

projectsRouter.get("/", async (req, res) => {
  const rows = await db.query.projects.findMany({
    where: eq(projects.companyId, req.companyId!),
    orderBy: (p, { desc }) => [desc(p.createdAt)],
  });
  res.json(rows);
});

const projectSchema = z.object({
  name: z.string().min(2, "اسم المشروع قصير جداً"),
  clientName: z.string().optional(),
  address: z.string().optional(),
  budgetTotal: z.coerce.number().nonnegative().default(0),
  startDate: z.string().optional(),
});

projectsRouter.post("/", async (req, res) => {
  const parsed = projectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { name, clientName, address, budgetTotal, startDate } = parsed.data;

  const [project] = await db
    .insert(projects)
    .values({
      companyId: req.companyId!,
      name,
      clientName,
      address,
      budgetTotal: String(budgetTotal),
      startDate,
    })
    .returning();

  res.status(201).json(project);
});

async function findOwnedProject(companyId: string, projectId: string) {
  return db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.companyId, companyId)),
  });
}

projectsRouter.get("/:id", async (req, res) => {
  const project = await findOwnedProject(req.companyId!, req.params.id);
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  res.json(project);
});

// budgetTotal is deliberately NOT part of this schema (unlike projectSchema
// above, which this is intentionally not derived from via .partial()).
// projects.budgetTotal is a legacy field: its only sanctioned writer is
// change-order approval (changeOrders.ts's atomic, owner-gated, audited SQL
// increment) — normal project updates must never be able to touch it.
// Discovery found this route previously accepted an unguarded, unaudited
// budgetTotal in its body, letting any member silently overwrite it outside
// that workflow; see docs/MIDAD_FINANCIAL_MODEL.md for why that field is
// not treated as authoritative for anything Phase 2 builds.
const updateSchema = z.object({
  name: z.string().min(2, "اسم المشروع قصير جداً").optional(),
  clientName: z.string().optional(),
  address: z.string().optional(),
  startDate: z.string().optional(),
  status: z.enum(["active", "on_hold", "completed"]).optional(),
});

projectsRouter.patch("/:id", async (req, res) => {
  const existing = await findOwnedProject(req.companyId!, req.params.id);
  if (!existing) return res.status(404).json({ error: "المشروع غير موجود" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  // A body containing only fields this schema doesn't recognize (e.g. a
  // stray budgetTotal — see the schema comment above) parses to an empty
  // object: nothing to set, so this is a no-op returning the project
  // unchanged, not a Drizzle "no values to set" error.
  if (Object.keys(parsed.data).length === 0) {
    return res.json(existing);
  }

  const [updated] = await db
    .update(projects)
    .set(parsed.data)
    .where(eq(projects.id, req.params.id))
    .returning();

  res.json(updated);
});

projectsRouter.delete("/:id", requirePermission("project.delete"), async (req, res) => {
  const existing = await findOwnedProject(req.companyId!, req.params.id);
  if (!existing) return res.status(404).json({ error: "المشروع غير موجود" });

  await db.delete(projects).where(eq(projects.id, req.params.id));
  logger.warn("destructive_mutation", { action: "project.delete", userId: req.userId, companyId: req.companyId, projectId: req.params.id });
  res.status(204).end();
});
