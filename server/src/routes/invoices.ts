import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, defaultFeatureFlags, invoiceItems, invoices, quotes, type CompanyFeatureFlags } from "../db/schema.js";
import { nextInvoiceNumber } from "../lib/numbering.js";
import { generateToken } from "../lib/tokens.js";
import { buildDocumentHtml, type DocumentLanguage } from "../lib/documentHtml.js";
import { renderHtmlToPdf } from "../lib/pdf.js";
import { logoFileToDataUri } from "../lib/uploads.js";
import { computeTotals } from "../lib/money.js";
import { requirePermission, getUserRole, isPermittedRole } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import { calculateTax } from "../lib/compliance/engine.js";

export const invoicesRouter = Router();
export const publicInvoicesRouter = Router();

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

// Each invoice carries its own frozen tax rate, so the amount + tax shown
// here is exactly what was true when it was issued — not recomputed from
// today's company settings. This is also what "الضريبة" per paid invoice
// means: the client sums taxAmount over status === "paid" rows itself.
invoicesRouter.get("/", async (req, res) => {
  const rows = await db.query.invoices.findMany({
    where: eq(invoices.companyId, req.companyId!),
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

invoicesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  // TC-02 fix: an explicit taxRatePercent bypasses the compliance engine
  // entirely — no ruleVersionId/override provenance gets recorded for it,
  // so a member could otherwise set an arbitrary rate with zero audit
  // trail. The engine-computed path below (taxRatePercent omitted) stays
  // open to any member; only a manual override needs owner.
  if (parsed.data.taxRatePercent !== undefined) {
    const role = await getUserRole(req.userId!);
    if (!isPermittedRole("invoice.overrideTax", role)) {
      return res.status(403).json({ error: "لا تملك صلاحية تحديد نسبة ضريبة يدوياً" });
    }
  }

  if (parsed.data.quoteId) {
    const quote = await db.query.quotes.findFirst({
      where: and(eq(quotes.id, parsed.data.quoteId), eq(quotes.companyId, req.companyId!)),
    });
    if (!quote) return res.status(404).json({ error: "عرض السعر غير موجود" });
  }

  const company = await db.query.companies.findFirst({ where: eq(companies.id, req.companyId!) });
  const invoiceNumber = await nextInvoiceNumber(req.companyId!);
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
  let taxRatePercent = parsed.data.taxRatePercent;
  let taxCategory: string | undefined;
  let ruleVersionId: string | undefined;
  let overrideReference: string | undefined;

  if (taxRatePercent === undefined) {
    const category = parsed.data.taxCategory ?? "standard_rate";
    const taxResult = await calculateTax({
      companyId: req.companyId!,
      transactionDate: issueDate,
      taxCategory: category,
      itemAmounts: parsed.data.items.map((item) => item.amount),
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

  const [invoice] = await db
    .insert(invoices)
    .values({
      companyId: req.companyId!,
      quoteId: parsed.data.quoteId,
      invoiceNumber,
      clientName: parsed.data.clientName,
      clientAddress: parsed.data.clientAddress,
      clientTaxId: parsed.data.clientTaxId,
      taxRatePercent: String(taxRatePercent),
      taxCategory,
      ruleVersionId,
      overrideReference,
      language: parsed.data.language,
      publicToken: generateToken(),
      issueDate,
      dueDate: parsed.data.dueDate,
    })
    .returning();

  await db.insert(invoiceItems).values(
    parsed.data.items.map((item) => ({
      invoiceId: invoice.id,
      description: item.description,
      amount: String(item.amount),
    })),
  );

  res.status(201).json(invoice);
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

  const [updated] = await db
    .update(invoices)
    .set({ status: "paid", paidAt: new Date() })
    .where(eq(invoices.id, invoice.id))
    .returning();
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
    console.error(err);
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
    console.error(err);
    res.status(500).json({ error: "تعذّر إنشاء ملف PDF" });
  }
});
