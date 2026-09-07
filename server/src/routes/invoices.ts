import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  companies,
  contracts,
  defaultFeatureFlags,
  invoiceItems,
  invoices,
  projects,
  quotes,
  type CompanyFeatureFlags,
} from "../db/schema.js";
import { nextInvoiceNumber } from "../lib/numbering.js";
import { generateToken } from "../lib/tokens.js";
import { buildDocumentHtml, type DocumentLanguage } from "../lib/documentHtml.js";
import { renderHtmlToPdf } from "../lib/pdf.js";
import { logoFileToDataUri } from "../lib/uploads.js";
import { computeTotals } from "../lib/money.js";
import { requirePermission, getUserRole, isPermittedRole } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { calculateTax } from "../lib/compliance/engine.js";
import { withIdempotency, IdempotencyConflictError } from "../lib/idempotency.js";
import { publicDocumentRateLimit } from "../middleware/rateLimit.js";

export const invoicesRouter = Router();
export const publicInvoicesRouter = Router();
export const projectInvoicesRouter = Router({ mergeParams: true });
publicInvoicesRouter.use(publicDocumentRateLimit);

// Invoicing is an optional module — a company that switched it off in
// settings gets a clean 403 instead of the feature quietly still working.
invoicesRouter.use(async (req, res, next) => {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, req.companyId!) });
  const flags = { ...defaultFeatureFlags, ...(company?.featureFlags as CompanyFeatureFlags) };
  if (!flags.invoicing) {
    return res.status(403).json({ error: "ميزة الفوترة معطّلة لهذه الشركة — يمكن تفعيلها من الإعدادات" });
  }
  next();
});

// Slice AA Scope G — company-wide invoice list is one of this slice's own
// priority pagination targets. Same limit/offset/hasMore convention as
// routes/auditEvents.ts and quotes.ts's list route: fetch limit+1 rows to
// detect hasMore without a separate COUNT query, deterministic
// newest-first ordering (unchanged), server-enforced max page size.
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

// Each invoice carries its own frozen tax rate, so the amount + tax shown
// here is exactly what was true when it was issued — not recomputed from
// today's company settings. This is also what "الضريبة" per paid invoice
// means: the client sums taxAmount over status === "paid" rows itself.
invoicesRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { limit, offset } = parsed.data;

  const rows = await db.query.invoices.findMany({
    where: eq(invoices.companyId, req.companyId!),
    orderBy: (i, { desc }) => [desc(i.createdAt)],
    limit: limit + 1,
    offset,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const withTotals = await Promise.all(
    page.map(async (invoice) => {
      const items = await db.query.invoiceItems.findMany({ where: eq(invoiceItems.invoiceId, invoice.id) });
      const totals = computeTotals(items.map((item) => Number(item.amount)), Number(invoice.taxRatePercent));
      return { ...invoice, ...totals };
    }),
  );
  res.json({ invoices: withTotals, limit, offset, hasMore });
});

// --- MIDAD UI-09: project-scoped invoices (Phase 2E's own gap, closed) ---
// Same tenant/ownership-scoping pattern as every other project sub-resource
// (contracts.ts, boq.ts, measurements.ts, ipcs.ts, ...): verify the project
// belongs to the caller's company before any route below runs. Reuses the
// exact same "compute totals per invoice via computeTotals()" logic as the
// company-wide GET / above — never a second, independent derivation.
projectInvoicesRouter.use(async (req: Request<{ projectId: string }>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

// Same optional-module gate as invoicesRouter above — a company that
// disabled invoicing gets the same clean 403 here, not a quiet bypass via
// the project-scoped path.
projectInvoicesRouter.use(async (req, res, next) => {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, req.companyId!) });
  const flags = { ...defaultFeatureFlags, ...(company?.featureFlags as CompanyFeatureFlags) };
  if (!flags.invoicing) {
    return res.status(403).json({ error: "ميزة الفوترة معطّلة لهذه الشركة — يمكن تفعيلها من الإعدادات" });
  }
  next();
});

projectInvoicesRouter.get("/", async (req: Request<{ projectId: string }>, res: Response) => {
  const rows = await db.query.invoices.findMany({
    where: and(eq(invoices.companyId, req.companyId!), eq(invoices.projectId, req.params.projectId)),
    orderBy: (i, { desc }) => [desc(i.createdAt)],
  });

  const withTotals = await Promise.all(
    rows.map(async (invoice) => {
      const items = await db.query.invoiceItems.findMany({ where: eq(invoiceItems.invoiceId, invoice.id) });
      const totals = computeTotals(items.map((item) => Number(item.amount)), Number(invoice.taxRatePercent));
      return { ...invoice, ...totals };
    }),
  );
  res.json(withTotals);
});

const languageEnum = z.enum(["ar", "fr", "en"]);

const createSchema = z.object({
  quoteId: z.string().uuid().optional(),
  // MIDAD Phase 2E foundation — both optional/nullable. See
  // resolveInvoiceProjectContract below for the exact validation and
  // derivation rules; neither is ever inferred from free text.
  projectId: z.string().uuid().optional(),
  contractId: z.string().uuid().optional(),
  clientName: z.string().min(2, "اسم العميل قصير جداً"),
  clientAddress: z.string().optional(),
  clientTaxId: z.string().optional(),
  taxRatePercent: z.coerce.number().min(0).max(100).optional(),
  taxCategory: z.string().optional(),
  language: languageEnum.default("ar"),
  dueDate: z.string().optional(),
  items: z
    .array(z.object({ description: z.string().min(1), amount: z.coerce.number().nonnegative() }))
    .min(1, "أضف بنداً واحداً على الأقل"),
});

// Independently validates projectId/contractId against the caller's own
// company — never trusted merely because they were supplied, and never
// derived from quotes.projectName or any other free-text match (the exact
// heuristic the Phase 2E discovery report explicitly ruled out). When a
// contractId is given, its own project is what actually gets stored — an
// independently-supplied, conflicting projectId is rejected rather than
// silently overridden or silently trusted.
async function resolveInvoiceProjectContract(
  companyId: string,
  input: { projectId?: string; contractId?: string },
): Promise<{ error: string; status: 404 | 400 } | { projectId?: string; contractId?: string }> {
  if (input.contractId) {
    const contract = await db.query.contracts.findFirst({
      where: and(eq(contracts.id, input.contractId), eq(contracts.companyId, companyId)),
    });
    if (!contract) return { error: "العقد غير موجود", status: 404 };
    if (input.projectId && input.projectId !== contract.projectId) {
      return { error: "العقد لا ينتمي إلى المشروع المحدد", status: 400 };
    }
    return { projectId: contract.projectId, contractId: contract.id };
  }

  if (input.projectId) {
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, input.projectId), eq(projects.companyId, companyId)),
    });
    if (!project) return { error: "المشروع غير موجود", status: 404 };
    return { projectId: project.id };
  }

  // Neither supplied — an unallocated, company-level invoice remains valid
  // product behavior (see docs/MIDAD_FINANCIAL_MODEL.md's Phase 2E note).
  return {};
}

async function createInvoice(
  companyId: string,
  userId: string,
  data: z.infer<typeof createSchema>,
): Promise<{ error: string; status: 400 | 403 | 404 } | { invoice: typeof invoices.$inferSelect }> {
  const relationship = await resolveInvoiceProjectContract(companyId, {
    projectId: data.projectId,
    contractId: data.contractId,
  });
  if ("error" in relationship) return relationship;

  // TC-02 fix: an explicit taxRatePercent bypasses the compliance engine
  // entirely — no ruleVersionId/override provenance gets recorded for it,
  // so a member could otherwise set an arbitrary rate with zero audit
  // trail. The engine-computed path below (taxRatePercent omitted) stays
  // open to any member; only a manual override needs owner.
  if (data.taxRatePercent !== undefined) {
    const role = await getUserRole(userId);
    if (!isPermittedRole("invoice.overrideTax", role)) {
      return { error: "لا تملك صلاحية تحديد نسبة ضريبة يدوياً", status: 403 };
    }
  }

  if (data.quoteId) {
    const quote = await db.query.quotes.findFirst({
      where: and(eq(quotes.id, data.quoteId), eq(quotes.companyId, companyId)),
    });
    if (!quote) return { error: "عرض السعر غير موجود", status: 404 };
  }

  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  const invoiceNumber = await nextInvoiceNumber(companyId);
  const issueDate = new Date().toISOString().slice(0, 10);

  // An explicit taxRatePercent in the request always wins (preserves the
  // pre-tax-engine behavior exactly). Otherwise, if this company has a
  // compliance profile configured, the tax engine computes the rate and
  // the result is frozen onto the invoice as a historical snapshot
  // (taxCategory/ruleVersionId/overrideReference) — a later rule or
  // override change never rewrites this invoice. A company with no
  // compliance profile (the common case until the customer completes
  // country onboarding) falls back to the company's flat default rate,
  // exactly as it always has.
  let taxRatePercent = data.taxRatePercent;
  let taxCategory: string | undefined;
  let ruleVersionId: string | undefined;
  let overrideReference: string | undefined;

  if (taxRatePercent === undefined) {
    const category = data.taxCategory ?? "standard_rate";
    const taxResult = await calculateTax({
      companyId,
      transactionDate: issueDate,
      taxCategory: category,
      itemAmounts: data.items.map((item) => item.amount),
    });
    if (taxResult.status === "calculated") {
      taxRatePercent = taxResult.taxRatePercent!;
      taxCategory = taxResult.taxCategory;
      ruleVersionId = taxResult.ruleVersionId!;
      overrideReference = taxResult.overrideReference ?? undefined;
    } else {
      taxRatePercent = Number(company!.defaultTaxRatePercent);
    }
  }

  // Parent insert, audit event, and line items must land together or not at
  // all — the same db.transaction pattern every other financial-creation
  // route in this codebase already uses (contracts.ts, boq.ts,
  // commitments.ts, measurements.ts, ipcs.ts). Without it, a failure between
  // the parent insert and the line-items insert would leave a permanently
  // orphaned, item-less invoice with no delete route to remove it.
  const invoice = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(invoices)
      .values({
        companyId,
        quoteId: data.quoteId,
        projectId: relationship.projectId,
        contractId: relationship.contractId,
        invoiceNumber,
        clientName: data.clientName,
        clientAddress: data.clientAddress,
        clientTaxId: data.clientTaxId,
        taxRatePercent: String(taxRatePercent),
        taxCategory,
        ruleVersionId,
        overrideReference,
        language: data.language,
        publicToken: generateToken(),
        issueDate,
        dueDate: data.dueDate,
      })
      .returning();

    // New for the Phase 2E foundation: invoices previously only wrote to the
    // structured log (see send/mark-paid below, unchanged) — the
    // project/contract relationship is financially meaningful enough that it
    // must be reconstructable via the canonical audit_events table, matching
    // every other domain's creation-event precedent.
    await recordAuditEvent(tx, {
      companyId,
      actorUserId: userId,
      action: "invoice.created",
      entityType: "invoice",
      entityId: created.id,
      afterValue: created,
      metadata: { projectId: relationship.projectId ?? null, contractId: relationship.contractId ?? null, quoteId: data.quoteId ?? null },
    });

    await tx.insert(invoiceItems).values(
      data.items.map((item) => ({
        invoiceId: created.id,
        description: item.description,
        amount: String(item.amount),
      })),
    );

    return created;
  });

  return { invoice };
}

invoicesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  // Slice AA Scope E — opt-in idempotency: a client that supplies an
  // Idempotency-Key header is protected from creating a duplicate invoice
  // on a retried request; a client that doesn't send the header keeps the
  // exact prior behavior.
  const idempotencyKey = req.header("Idempotency-Key");
  if (idempotencyKey) {
    try {
      const outcome = await withIdempotency<typeof invoices.$inferSelect | { error: string; status: number }>(
        req.companyId!,
        "invoice.create",
        idempotencyKey,
        req.body,
        async () => {
          const result = await createInvoice(req.companyId!, req.userId!, parsed.data);
          if ("error" in result) return { status: result.status, body: result };
          return { status: 201, body: result.invoice };
        },
      );
      return res.status(outcome.status).json(outcome.body);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return res.status(409).json({ error: "تم استخدام مفتاح idempotency هذا مسبقاً بطلب مختلف" });
      }
      throw err;
    }
  }

  const result = await createInvoice(req.companyId!, req.userId!, parsed.data);
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.invoice);
});

async function findOwnedInvoice(companyId: string, invoiceId: string) {
  return db.query.invoices.findFirst({ where: and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)) });
}

invoicesRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const invoice = await findOwnedInvoice(req.companyId!, req.params.id);
  if (!invoice) return res.status(404).json({ error: "الفاتورة غير موجودة" });

  const items = await db.query.invoiceItems.findMany({ where: eq(invoiceItems.invoiceId, invoice.id) });
  res.json({ ...invoice, items });
});

invoicesRouter.patch("/:id/send", requirePermission("invoice.send"), async (req: Request<{ id: string }>, res: Response) => {
  const invoice = await findOwnedInvoice(req.companyId!, req.params.id);
  if (!invoice) return res.status(404).json({ error: "الفاتورة غير موجودة" });
  if (invoice.status !== "draft") return res.status(409).json({ error: "تم إرسال الفاتورة مسبقاً" });

  const [updated] = await db.update(invoices).set({ status: "sent" }).where(eq(invoices.id, invoice.id)).returning();
  logger.info("financial_mutation", { action: "invoice.send", userId: req.userId, companyId: req.companyId, invoiceId: invoice.id });
  res.json(updated);
});

// No real payment collection is wired up yet (needs Stripe) — this is the
// honest MVP behavior: the owner records that they got paid some other way.
// Invoice lifecycle is draft -> sent -> paid, strictly in that order: an
// invoice can only be marked paid once it has actually been sent to the
// client (draft -> paid directly is not a valid transition).
invoicesRouter.patch("/:id/mark-paid", requirePermission("invoice.markPaid"), async (req: Request<{ id: string }>, res: Response) => {
  const invoice = await findOwnedInvoice(req.companyId!, req.params.id);
  if (!invoice) return res.status(404).json({ error: "الفاتورة غير موجودة" });
  if (invoice.status === "paid") return res.status(409).json({ error: "الفاتورة مُسدَّدة مسبقاً" });
  if (invoice.status !== "sent") {
    return res.status(409).json({ error: "يجب إرسال الفاتورة أولاً قبل تسجيلها كمسدَّدة" });
  }

  // Slice AA — conditional UPDATE (WHERE status = 'sent'), not a plain
  // eq(id) — the findOwnedInvoice status checks above alone were a
  // read-then-write race (two concurrent mark-paid requests could both
  // pass them before either write executed). Only the request whose
  // UPDATE still finds status='sent' at the moment it runs can succeed,
  // mirroring the same pattern used in routes/changeOrders.ts and now
  // routes/quotes.ts's accept/reject.
  const [updated] = await db
    .update(invoices)
    .set({ status: "paid", paidAt: new Date() })
    .where(and(eq(invoices.id, invoice.id), eq(invoices.status, "sent")))
    .returning();
  if (!updated) return res.status(409).json({ error: "الفاتورة مُسدَّدة مسبقاً" });
  logger.info("financial_mutation", { action: "invoice.markPaid", userId: req.userId, companyId: req.companyId, invoiceId: invoice.id });
  res.json(updated);
});

async function buildInvoicePdf(invoiceId: string, companyId: string) {
  const invoice = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)),
  });
  if (!invoice) return null;

  const [items, company] = await Promise.all([
    db.query.invoiceItems.findMany({ where: eq(invoiceItems.invoiceId, invoice.id) }),
    db.query.companies.findFirst({ where: eq(companies.id, companyId) }),
  ]);

  const html = buildDocumentHtml({
    kind: "invoice",
    language: invoice.language as DocumentLanguage,
    number: invoice.invoiceNumber,
    date: invoice.issueDate,
    company: {
      name: company!.name,
      logoDataUri: logoFileToDataUri(company!.logoPath),
      address: company!.address,
      taxId: company!.taxId,
      phone: company!.phone,
    },
    client: { name: invoice.clientName, address: invoice.clientAddress, taxId: invoice.clientTaxId },
    items: items.map((i) => ({ description: i.description, amount: Number(i.amount) })),
    taxRatePercent: Number(invoice.taxRatePercent),
  });

  return renderHtmlToPdf(html);
}

invoicesRouter.get("/:id/pdf", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const pdf = await buildInvoicePdf(req.params.id, req.companyId!);
    if (!pdf) return res.status(404).json({ error: "الفاتورة غير موجودة" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="invoice.pdf"`);
    res.send(pdf);
  } catch (err) {
    logger.error("invoice_pdf_generation_failed", {
      companyId: req.companyId,
      invoiceId: req.params.id,
      message: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "تعذّر إنشاء ملف PDF" });
  }
});

// --- Public: the client's view of a sent invoice, no account needed ---

publicInvoicesRouter.get("/:token", async (req: Request<{ token: string }>, res: Response) => {
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.publicToken, req.params.token) });
  if (!invoice || invoice.status === "draft") return res.status(404).json({ error: "الفاتورة غير موجودة" });

  const [items, company] = await Promise.all([
    db.query.invoiceItems.findMany({ where: eq(invoiceItems.invoiceId, invoice.id) }),
    db.query.companies.findFirst({ where: eq(companies.id, invoice.companyId) }),
  ]);

  const { total } = computeTotals(items.map((i) => Number(i.amount)), Number(invoice.taxRatePercent));
  res.json({
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    companyName: company?.name ?? "",
    clientName: invoice.clientName,
    items,
    taxRatePercent: Number(invoice.taxRatePercent),
    total,
  });
});

publicInvoicesRouter.get("/:token/pdf", async (req: Request<{ token: string }>, res: Response) => {
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.publicToken, req.params.token) });
  if (!invoice || invoice.status === "draft") return res.status(404).json({ error: "الفاتورة غير موجودة" });

  try {
    const pdf = await buildInvoicePdf(invoice.id, invoice.companyId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="invoice.pdf"`);
    res.send(pdf);
  } catch (err) {
    logger.error("invoice_pdf_generation_failed", {
      companyId: invoice.companyId,
      invoiceId: invoice.id,
      message: err instanceof Error ? err.message : "unknown error",
    });
    res.status(500).json({ error: "تعذّر إنشاء ملف PDF" });
  }
});
