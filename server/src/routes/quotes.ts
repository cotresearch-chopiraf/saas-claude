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

export const quotesRouter = Router();
export const publicQuotesRouter = Router();

quotesRouter.get("/", async (req, res) => {
  const rows = await db.query.quotes.findMany({
    where: eq(quotes.companyId, req.companyId!),
    orderBy: (q, { desc }) => [desc(q.createdAt)],
  });

  const withTotals = await Promise.all(
    rows.map(async (quote) => {
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
  res.json(withTotals);
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

quotesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  let taxRatePercent: number | undefined;
  let taxCategory: string | undefined;
  let ruleVersionId: string | undefined;
  let overrideReference: string | undefined;

  if (parsed.data.taxCategory) {
    const taxResult = await calculateTax({
      companyId: req.companyId!,
      transactionDate: new Date().toISOString().slice(0, 10),
      taxCategory: parsed.data.taxCategory,
      itemAmounts: parsed.data.items.map((item) => item.amount),
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

  const [quote] = await db
    .insert(quotes)
    .values({
      companyId: req.companyId!,
      quoteNumber: await nextQuoteNumber(req.companyId!),
      clientName: parsed.data.clientName,
      clientEmail: parsed.data.clientEmail || undefined,
      projectName: parsed.data.projectName,
      language: parsed.data.language,
      taxRatePercent: taxRatePercent !== undefined ? String(taxRatePercent) : undefined,
      taxCategory,
      ruleVersionId,
      overrideReference,
      publicToken: generateToken(),
    })
    .returning();

  await db.insert(quoteItems).values(
    parsed.data.items.map((item) => ({
      quoteId: quote.id,
      description: item.description,
      amount: String(item.amount),
    })),
  );

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
  if (!quote || quote.status !== "sent") return res.status(409).json({ error: "لا يمكن قبول عرض السعر هذا" });

  const [updated] = await db
    .update(quotes)
    .set({ status: "accepted", acceptedByName: parsed.data.acceptedByName, acceptedAt: new Date() })
    .where(eq(quotes.id, quote.id))
    .returning();
  res.json(updated);
});

publicQuotesRouter.post("/:token/reject", async (req: Request<{ token: string }>, res: Response) => {
  const quote = await db.query.quotes.findFirst({ where: eq(quotes.publicToken, req.params.token) });
  if (!quote || quote.status !== "sent") return res.status(409).json({ error: "لا يمكن رفض عرض السعر هذا" });

  const [updated] = await db.update(quotes).set({ status: "rejected" }).where(eq(quotes.id, quote.id)).returning();
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
