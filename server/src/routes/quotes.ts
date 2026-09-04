import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, quoteItems, quotes } from "../db/schema.js";
import { generateToken } from "../lib/tokens.js";
import { nextQuoteNumber } from "../lib/numbering.js";
import { buildDocumentHtml, type DocumentLanguage } from "../lib/documentHtml.js";
import { renderHtmlToPdf } from "../lib/pdf.js";
import { logoFileToDataUri } from "../lib/uploads.js";
import { computeTotals } from "../lib/money.js";
import { requirePermission } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import { calculateTax } from "../lib/compliance/engine.js";
import { withIdempotency, IdempotencyConflictError } from "../lib/idempotency.js";

export const quotesRouter = Router();
export const publicQuotesRouter = Router();

// Slice AA Scope G — company-wide quote list is one of this slice's own
// priority pagination targets. Same limit/offset/hasMore convention as
// routes/auditEvents.ts: fetch limit+1 rows to detect hasMore without a
// separate COUNT query, deterministic newest-first ordering (unchanged),
// server-enforced max page size (a client can never request an unbounded
// page).
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

quotesRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { limit, offset } = parsed.data;

  const rows = await db.query.quotes.findMany({
    where: eq(quotes.companyId, req.companyId!),
    orderBy: (q, { desc }) => [desc(q.createdAt)],
    limit: limit + 1,
    offset,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const withTotals = await Promise.all(
    page.map(async (quote) => {
      const items = await db.query.quoteItems.findMany({ where: eq(quoteItems.quoteId, quote.id) });
      // Quotes are opt-in to tax (see createSchema above): a quote's own
      // frozen taxRatePercent is used when present, exactly as invoices.ts
      // already does — never a hardcoded 0 that silently discards a tax
      // category the write path correctly computed and stored.
      const taxRatePercent = quote.taxRatePercent !== null ? Number(quote.taxRatePercent) : 0;
      const totals = computeTotals(items.map((item) => Number(item.amount)), taxRatePercent);
      return { ...quote, ...totals };
    }),
  );
  res.json({ quotes: withTotals, limit, offset, hasMore });
});

const languageEnum = z.enum(["ar", "fr", "en"]);

const createSchema = z.object({
  clientName: z.string().min(2, "اسم العميل قصير جداً"),
  clientEmail: z.string().email().optional().or(z.literal("")),
  projectName: z.string().min(2, "اسم المشروع قصير جداً"),
  language: languageEnum.default("ar"),
  // Opt-in only: a quote that doesn't ask for a tax category stays exactly
  // what it always was — a plain line-item sum, no tax fields. This is
  // deliberate: quotes never had a tax concept before the compliance
  // engine existed, and nothing should silently start taxing an existing
  // integration's quotes that never asked for it.
  taxCategory: z.string().optional(),
  items: z
    .array(z.object({ description: z.string().min(1), amount: z.coerce.number().nonnegative() }))
    .min(1, "أضف بنداً واحداً على الأقل"),
});

async function createQuote(companyId: string, data: z.infer<typeof createSchema>) {
  let taxRatePercent: number | undefined;
  let taxCategory: string | undefined;
  let ruleVersionId: string | undefined;
  let overrideReference: string | undefined;

  if (data.taxCategory) {
    const taxResult = await calculateTax({
      companyId,
      transactionDate: new Date().toISOString().slice(0, 10),
      taxCategory: data.taxCategory,
      itemAmounts: data.items.map((item) => item.amount),
    });
    if (taxResult.status === "calculated") {
      taxRatePercent = taxResult.taxRatePercent!;
      taxCategory = taxResult.taxCategory;
      ruleVersionId = taxResult.ruleVersionId!;
      overrideReference = taxResult.overrideReference ?? undefined;
    }
    // status === "review_required": quote is created without a tax
    // snapshot rather than blocking quote creation on a compliance gap —
    // the compliance status endpoint is where that gap gets surfaced.
  }

  // Parent insert and line items must land together or not at all — the
  // same db.transaction pattern every other financial-creation route in
  // this codebase already uses (contracts.ts, boq.ts, commitments.ts,
  // invoices.ts). Without it, a failure between the two inserts would
  // leave a permanently orphaned, item-less quote.
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(quotes)
      .values({
        companyId,
        quoteNumber: await nextQuoteNumber(companyId),
        clientName: data.clientName,
        clientEmail: data.clientEmail || undefined,
        projectName: data.projectName,
        language: data.language,
        taxRatePercent: taxRatePercent !== undefined ? String(taxRatePercent) : undefined,
        taxCategory,
        ruleVersionId,
        overrideReference,
        publicToken: generateToken(),
      })
      .returning();

    await tx.insert(quoteItems).values(
      data.items.map((item) => ({
        quoteId: created.id,
        description: item.description,
        amount: String(item.amount),
      })),
    );

    return created;
  });
}

quotesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  // Slice AA Scope E — opt-in idempotency: a client that supplies an
  // Idempotency-Key header is protected from creating a duplicate quote on
  // a retried request (network timeout, double submit); a client that
  // doesn't send the header keeps the exact prior behavior.
  const idempotencyKey = req.header("Idempotency-Key");
  if (idempotencyKey) {
    try {
      const outcome = await withIdempotency(req.companyId!, "quote.create", idempotencyKey, req.body, async () => {
        const created = await createQuote(req.companyId!, parsed.data);
        return { status: 201, body: created };
      });
      return res.status(outcome.status).json(outcome.body);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return res.status(409).json({ error: "تم استخدام مفتاح idempotency هذا مسبقاً بطلب مختلف" });
      }
      throw err;
    }
  }

  const quote = await createQuote(req.companyId!, parsed.data);
  res.status(201).json(quote);
});

async function findOwnedQuote(companyId: string, quoteId: string) {
  return db.query.quotes.findFirst({
    where: and(eq(quotes.id, quoteId), eq(quotes.companyId, companyId)),
  });
}

quotesRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const quote = await findOwnedQuote(req.companyId!, req.params.id);
  if (!quote) return res.status(404).json({ error: "عرض السعر غير موجود" });

  const items = await db.query.quoteItems.findMany({ where: eq(quoteItems.quoteId, quote.id) });
  res.json({ ...quote, items });
});

quotesRouter.patch("/:id/send", requirePermission("quote.send"), async (req: Request<{ id: string }>, res: Response) => {
  const quote = await findOwnedQuote(req.companyId!, req.params.id);
  if (!quote) return res.status(404).json({ error: "عرض السعر غير موجود" });
  if (quote.status !== "draft") return res.status(409).json({ error: "تم إرسال عرض السعر مسبقاً" });

  const [updated] = await db.update(quotes).set({ status: "sent" }).where(eq(quotes.id, quote.id)).returning();
  logger.info("financial_mutation", { action: "quote.send", userId: req.userId, companyId: req.companyId, quoteId: quote.id });
  res.json(updated);
});

quotesRouter.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const quote = await findOwnedQuote(req.companyId!, req.params.id);
  if (!quote) return res.status(404).json({ error: "عرض السعر غير موجود" });
  if (quote.status !== "draft") return res.status(409).json({ error: "لا يمكن حذف عرض سعر تم إرساله" });

  await db.delete(quotes).where(eq(quotes.id, quote.id));
  res.status(204).end();
});

async function buildQuotePdf(quoteId: string, companyId: string) {
  const quote = await db.query.quotes.findFirst({ where: and(eq(quotes.id, quoteId), eq(quotes.companyId, companyId)) });
  if (!quote) return null;

  const [items, company] = await Promise.all([
    db.query.quoteItems.findMany({ where: eq(quoteItems.quoteId, quote.id) }),
    db.query.companies.findFirst({ where: eq(companies.id, companyId) }),
  ]);

  const html = buildDocumentHtml({
    kind: "quote",
    language: quote.language as DocumentLanguage,
    number: quote.quoteNumber ?? quote.id.slice(0, 8),
    date: quote.createdAt.toISOString().slice(0, 10),
    company: {
      name: company!.name,
      logoDataUri: logoFileToDataUri(company!.logoPath),
      address: company!.address,
      taxId: company!.taxId,
      phone: company!.phone,
    },
    client: { name: quote.clientName, address: null, taxId: null },
    items: items.map((i) => ({ description: i.description, amount: Number(i.amount) })),
    // The quote's own frozen taxRatePercent, exactly as its create-time
    // snapshot recorded it — never the company's CURRENT default. Using the
    // company default here was the original bug (TC-01): a company that
    // changes its default tax rate later would retroactively change the
    // displayed tax on every past quote's PDF, and an untaxed quote (never
    // opted into a taxCategory) would incorrectly show tax at all.
    taxRatePercent: quote.taxRatePercent !== null ? Number(quote.taxRatePercent) : 0,
  });

  return renderHtmlToPdf(html);
}

quotesRouter.get("/:id/pdf", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const pdf = await buildQuotePdf(req.params.id, req.companyId!);
    if (!pdf) return res.status(404).json({ error: "عرض السعر غير موجود" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="quote.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذّر إنشاء ملف PDF" });
  }
});

// --- Public, unauthenticated: this is what the client opens from a link ---

publicQuotesRouter.get("/:token", async (req: Request<{ token: string }>, res: Response) => {
  const quote = await db.query.quotes.findFirst({ where: eq(quotes.publicToken, req.params.token) });
  if (!quote || quote.status === "draft") return res.status(404).json({ error: "عرض السعر غير موجود" });

  const items = await db.query.quoteItems.findMany({ where: eq(quoteItems.quoteId, quote.id) });
  const company = await db.query.companies.findFirst({ where: eq(companies.id, quote.companyId) });

  const taxRatePercent = quote.taxRatePercent !== null ? Number(quote.taxRatePercent) : 0;
  const { total } = computeTotals(items.map((item) => Number(item.amount)), taxRatePercent);
  res.json({
    projectName: quote.projectName,
    clientName: quote.clientName,
    status: quote.status,
    companyName: company?.name ?? "",
    items,
    taxRatePercent,
    total,
  });
});

const decisionSchema = z.object({ acceptedByName: z.string().min(2, "الاسم قصير جداً") });

publicQuotesRouter.post("/:token/accept", async (req: Request<{ token: string }>, res: Response) => {
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const quote = await db.query.quotes.findFirst({ where: eq(quotes.publicToken, req.params.token) });
  if (!quote) return res.status(409).json({ error: "لا يمكن قبول عرض السعر هذا" });

  // Slice AA — conditional UPDATE (WHERE status = 'sent'), not a plain
  // eq(id) — the earlier findFirst's status check alone was a genuine
  // read-then-write race: two concurrent accept requests (or an
  // accept/reject race) could both pass that check before either write
  // executed. Only the request whose UPDATE still finds status='sent' at
  // the moment it runs can ever succeed now, mirroring the exact pattern
  // already proven in routes/changeOrders.ts's decision route.
  const [updated] = await db
    .update(quotes)
    .set({ status: "accepted", acceptedByName: parsed.data.acceptedByName, acceptedAt: new Date() })
    .where(and(eq(quotes.id, quote.id), eq(quotes.status, "sent")))
    .returning();
  if (!updated) return res.status(409).json({ error: "لا يمكن قبول عرض السعر هذا" });
  res.json(updated);
});

publicQuotesRouter.post("/:token/reject", async (req: Request<{ token: string }>, res: Response) => {
  const quote = await db.query.quotes.findFirst({ where: eq(quotes.publicToken, req.params.token) });
  if (!quote) return res.status(409).json({ error: "لا يمكن رفض عرض السعر هذا" });

  // Slice AA — same conditional-UPDATE hardening as accept above.
  const [updated] = await db
    .update(quotes)
    .set({ status: "rejected" })
    .where(and(eq(quotes.id, quote.id), eq(quotes.status, "sent")))
    .returning();
  if (!updated) return res.status(409).json({ error: "لا يمكن رفض عرض السعر هذا" });
  res.json(updated);
});

publicQuotesRouter.get("/:token/pdf", async (req: Request<{ token: string }>, res: Response) => {
  const quote = await db.query.quotes.findFirst({ where: eq(quotes.publicToken, req.params.token) });
  if (!quote || quote.status === "draft") return res.status(404).json({ error: "عرض السعر غير موجود" });

  try {
    const pdf = await buildQuotePdf(quote.id, quote.companyId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="quote.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذّر إنشاء ملف PDF" });
  }
});
