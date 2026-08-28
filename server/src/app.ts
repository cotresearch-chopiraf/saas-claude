import express from "express";
import cors from "cors";
import multer from "multer";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { budgetRouter } from "./routes/budget.js";
import { tasksRouter } from "./routes/tasks.js";
import { changeOrdersRouter } from "./routes/changeOrders.js";
import { dailyLogsRouter } from "./routes/dailyLogs.js";
import { companyRouter } from "./routes/company.js";
import { quotesRouter, publicQuotesRouter } from "./routes/quotes.js";
import { invoicesRouter, publicInvoicesRouter } from "./routes/invoices.js";
import { requireAuth } from "./middleware/auth.js";
import { uploadsDir } from "./lib/uploads.js";

export function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  // Local-disk logo storage — see lib/uploads.ts for why this is a stopgap.
  app.use("/uploads", express.static(uploadsDir));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, projectsRouter);
  app.use("/api/projects/:projectId/budget", requireAuth, budgetRouter);
  app.use("/api/projects/:projectId/tasks", requireAuth, tasksRouter);
  app.use("/api/projects/:projectId/change-orders", requireAuth, changeOrdersRouter);
  app.use("/api/projects/:projectId/daily-logs", requireAuth, dailyLogsRouter);
  app.use("/api/company", requireAuth, companyRouter);
  app.use("/api/quotes", requireAuth, quotesRouter);
  app.use("/api/public/quotes", publicQuotesRouter);
  app.use("/api/invoices", requireAuth, invoicesRouter);
  app.use("/api/public/invoices", publicInvoicesRouter);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "حدث خطأ غير متوقع في الخادم" });
  });

  return app;
}
