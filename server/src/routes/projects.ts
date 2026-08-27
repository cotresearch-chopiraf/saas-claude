import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects } from "../db/schema.js";

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

const updateSchema = projectSchema.partial().extend({
  status: z.enum(["active", "on_hold", "completed"]).optional(),
});

projectsRouter.patch("/:id", async (req, res) => {
  const existing = await findOwnedProject(req.companyId!, req.params.id);
  if (!existing) return res.status(404).json({ error: "المشروع غير موجود" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { budgetTotal, ...rest } = parsed.data;
  const [updated] = await db
    .update(projects)
    .set({
      ...rest,
      ...(budgetTotal !== undefined ? { budgetTotal: String(budgetTotal) } : {}),
    })
    .where(eq(projects.id, req.params.id))
    .returning();

  res.json(updated);
});

projectsRouter.delete("/:id", async (req, res) => {
  const existing = await findOwnedProject(req.companyId!, req.params.id);
  if (!existing) return res.status(404).json({ error: "المشروع غير موجود" });

  await db.delete(projects).where(eq(projects.id, req.params.id));
  res.status(204).end();
});
