// Must be the first import: patches Express so a rejected promise inside an
// async route handler is forwarded to the error middleware instead of
// crashing the whole process (Express 4 doesn't do this natively — a single
// malformed request, e.g. a non-UUID :id hitting Postgres, used to take the
// entire server down for every concurrent user).
import "express-async-errors";
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
import { invoicesRouter, publicInvoicesRouter, projectInvoicesRouter } from "./routes/invoices.js";
import { complianceRouter } from "./routes/compliance.js";
import { contractsRouter } from "./routes/contracts.js";
import { costCodesRouter } from "./routes/costCodes.js";
import { boqRouter } from "./routes/boq.js";
import { budgetRevisionsRouter } from "./routes/budgetRevisions.js";
import { suppliersRouter } from "./routes/suppliers.js";
import { customersRouter } from "./routes/customers.js";
import { commitmentsRouter } from "./routes/commitments.js";
import { measurementsRouter } from "./routes/measurements.js";
import { ipcsRouter } from "./routes/ipcs.js";
import { subcontractIpcsRouter } from "./routes/subcontractIpcs.js";
import { subcontractIpcDocumentsRouter } from "./routes/subcontractIpcDocuments.js";
import { forecastRouter } from "./routes/forecast.js";
import { cashflowRouter } from "./routes/cashflow.js";
import { documentsRouter } from "./routes/documents.js";
import { requireAuth } from "./middleware/auth.js";
import { uploadsDir } from "./lib/uploads.js";
import { logger } from "./lib/logger.js";

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
  app.use("/api/projects/:projectId/contracts", requireAuth, contractsRouter);
  app.use("/api/projects/:projectId/boq-revisions", requireAuth, boqRouter);
  app.use("/api/projects/:projectId/budget-revisions", requireAuth, budgetRevisionsRouter);
  app.use("/api/projects/:projectId/commitments", requireAuth, commitmentsRouter);
  app.use("/api/projects/:projectId/measurements", requireAuth, measurementsRouter);
  app.use("/api/projects/:projectId/ipcs", requireAuth, ipcsRouter);
  app.use("/api/projects/:projectId/subcontract-ipcs", requireAuth, subcontractIpcsRouter);
  app.use("/api/projects/:projectId/subcontract-ipcs/:ipcId/documents", requireAuth, subcontractIpcDocumentsRouter);
  app.use("/api/projects/:projectId/forecast", requireAuth, forecastRouter);
  app.use("/api/projects/:projectId/cash-flow", requireAuth, cashflowRouter);
  app.use("/api/projects/:projectId/invoices", requireAuth, projectInvoicesRouter);
  app.use("/api/projects/:projectId/documents", requireAuth, documentsRouter);
  app.use("/api/cost-codes", requireAuth, costCodesRouter);
  app.use("/api/suppliers", requireAuth, suppliersRouter);
  app.use("/api/customers", requireAuth, customersRouter);
  app.use("/api/company", requireAuth, companyRouter);
  app.use("/api/quotes", requireAuth, quotesRouter);
  app.use("/api/public/quotes", publicQuotesRouter);
  app.use("/api/invoices", requireAuth, invoicesRouter);
  app.use("/api/public/invoices", publicInvoicesRouter);
  app.use("/api/compliance", requireAuth, complianceRouter);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error("unhandled_error", {
      message: err.message,
      name: err.name,
      path: req.path,
      method: req.method,
    });
    res.status(500).json({ error: "حدث خطأ غير متوقع في الخادم" });
  });

  return app;
}
