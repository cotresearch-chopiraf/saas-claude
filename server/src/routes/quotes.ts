import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, quoteItems, quotes } from "../db/schema.js";
import { generateToken } from "../lib/tokens.js";

export const quotesRouter = Router();
export const publicQuotesRouter = Router();

quotesRouter.get("/", async (req, res) => {
  const rows = await db.query.quotes.findMany({
    where: eq(quotes.companyId, req.companyId!),
    orderBy: (q, { desc }) => [desc(q.createdAt)],
  });
  res.json(rows);
});

const createSchema = z.object({
  clientName: z.string().min(2, "اسم العميل قصير جداً"),
  clientEmail: z.string().email().optional().or(z.literal("")),
  projectName: z.string().min(2, "اسم المشروع قصير جداً"),
  items: z
    .array(z.object({ description: z.string().min(1), amount: z.coerce.number().nonnegative() }))
    .min(1, "أضف بنداً واحداً على الأقل"),
});

quotesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const [quote] = await db
    .insert(quotes)
    .values({
      companyId: req.companyId!,
      clientName: parsed.data.clientName,
      clientEmail: parsed.data.clientEmail || undefined,
      projectName: parsed.data.projectName,
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

quotesRouter.patch("/:id/send", async (req: Request<{ id: string }>, res: Response) => {
  const quote = await findOwnedQuote(req.companyId!, req.params.id);
  if (!quote) return res.status(404).json({ error: "عرض السعر غير موجود" });
  if (quote.status !== "draft") return res.status(409).json({ error: "تم إرسال عرض السعر مسبقاً" });

  const [updated] = await db.update(quotes).set({ status: "sent" }).where(eq(quotes.id, quote.id)).returning();
  res.json(updated);
});

quotesRouter.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const quote = await findOwnedQuote(req.companyId!, req.params.id);
  if (!quote) return res.status(404).json({ error: "عرض السعر غير موجود" });
  if (quote.status !== "draft") return res.status(409).json({ error: "لا يمكن حذف عرض سعر تم إرساله" });

  await db.delete(quotes).where(eq(quotes.id, quote.id));
  res.status(204).end();
});

// --- Public, unauthenticated: this is what the client opens from a link ---

publicQuotesRouter.get("/:token", async (req: Request<{ token: string }>, res: Response) => {
  const quote = await db.query.quotes.findFirst({ where: eq(quotes.publicToken, req.params.token) });
  if (!quote || quote.status === "draft") return res.status(404).json({ error: "عرض السعر غير موجود" });

  const items = await db.query.quoteItems.findMany({ where: eq(quoteItems.quoteId, quote.id) });
  const company = await db.query.companies.findFirst({ where: eq(companies.id, quote.companyId) });

  res.json({
    projectName: quote.projectName,
    clientName: quote.clientName,
    status: quote.status,
    companyName: company?.name ?? "",
    items,
    total: items.reduce((sum, item) => sum + Number(item.amount), 0),
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
