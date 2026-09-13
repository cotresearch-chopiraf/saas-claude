import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { plans, companies, defaultPlanLimits } from "../db/schema.js";
import { recordAuditEvent } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { requirePlatformCapability } from "../lib/platformPermissions.js";

// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit) —
// platform-admin CRUD over the plan registry and per-company plan
// assignment. Mounted behind platformAuth (never requireAuth) in app.ts,
// same discipline as every other routes/platform*.ts file. See
// db/schema.ts's comment above `plans` — no price/billing field exists
// here by design.
export const platformPlansRouter = Router();

platformPlansRouter.get("/", requirePlatformCapability("plans.read"), async (_req, res) => {
  const rows = await db.query.plans.findMany({ orderBy: (p, { asc }) => [asc(p.name)] });
  res.json({ plans: rows });
});

const limitsSchema = z
  .object({
    maxUsers: z.number().int().positive().nullable(),
    maxProjects: z.number().int().positive().nullable(),
    maxStorageMb: z.number().int().positive().nullable(),
    maxInvoicesPerMonth: z.number().int().positive().nullable(),
  })
  .partial();

const createPlanSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2, "مفتاح الخطة قصير جداً")
    .regex(/^[a-z][a-z0-9_]*$/, "المفتاح يجب أن يكون بأحرف إنجليزية صغيرة وأرقام وشرطة سفلية فقط، ويبدأ بحرف"),
  name: z.string().trim().min(2, "اسم الخطة قصير جداً"),
  description: z.string().trim().optional(),
  isActive: z.boolean().optional().default(true),
  limits: limitsSchema.optional(),
});

platformPlansRouter.post("/", requirePlatformCapability("plans.manage"), async (req, res) => {
  const parsed = createPlanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await db.query.plans.findFirst({ where: eq(plans.key, parsed.data.key) });
  if (existing) return res.status(409).json({ error: "مفتاح الخطة مستخدم بالفعل" });

  const [created] = await db
    .insert(plans)
    .values({
      key: parsed.data.key,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      isActive: parsed.data.isActive,
      limits: { ...defaultPlanLimits, ...parsed.data.limits },
    })
    .returning();

  logger.info("plan_created", { platformOperatorId: req.platformOperatorId, planKey: created.key, limits: created.limits });
  res.status(201).json(created);
});

const updatePlanSchema = z.object({
  name: z.string().trim().min(2, "اسم الخطة قصير جداً").optional(),
  description: z.string().trim().nullable().optional(),
  isActive: z.boolean().optional(),
  limits: limitsSchema.optional(),
});

platformPlansRouter.patch("/:key", requirePlatformCapability("plans.manage"), async (req, res) => {
  const parsed = updatePlanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await db.query.plans.findFirst({ where: eq(plans.key, req.params.key) });
  if (!existing) return res.status(404).json({ error: "الخطة غير موجودة" });

  const { limits, ...rest } = parsed.data;
  const [updated] = await db
    .update(plans)
    .set({
      ...rest,
      ...(limits ? { limits: { ...existing.limits, ...limits } } : {}),
      updatedAt: new Date(),
    })
    .where(eq(plans.key, req.params.key))
    .returning();

  logger.info("plan_updated", {
    platformOperatorId: req.platformOperatorId,
    planKey: updated.key,
    before: { isActive: existing.isActive, limits: existing.limits },
    after: { isActive: updated.isActive, limits: updated.limits },
  });

  res.json(updated);
});

const assignPlanSchema = z.object({ planKey: z.string().nullable() });

// Assigning null clears the company's plan (reverts to unlimited — see
// db/schema.ts's companies.planId comment).
platformPlansRouter.put("/assignments/:companyId", requirePlatformCapability("plans.manage"), async (req, res) => {
  const parsed = assignPlanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const company = await db.query.companies.findFirst({ where: eq(companies.id, req.params.companyId) });
  if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });

  let planId: string | null = null;
  if (parsed.data.planKey !== null) {
    const plan = await db.query.plans.findFirst({ where: eq(plans.key, parsed.data.planKey) });
    if (!plan) return res.status(404).json({ error: "الخطة غير موجودة" });
    planId = plan.id;
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(companies).set({ planId }).where(eq(companies.id, req.params.companyId)).returning();

    await recordAuditEvent(tx, {
      companyId: req.params.companyId,
      actorUserId: null,
      action: "plan.assigned",
      entityType: "company",
      entityId: req.params.companyId,
      beforeValue: { planId: company.planId },
      afterValue: { planId },
      source: "platform_admin",
      metadata: { platformOperatorId: req.platformOperatorId, planKey: parsed.data.planKey },
    });

    return row;
  });

  res.json({ companyId: updated.id, planId: updated.planId });
});
