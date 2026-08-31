// Must be the first import: patches Express so a rejected promise inside an
// async route handler is forwarded to the error middleware instead of
// crashing the whole process (Express 4 doesn't do this natively — a single
// malformed request, e.g. a non-UUID :id hitting Postgres, used to take the
// entire server down for every concurrent user).
import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
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
import { auditEventsRouter } from "./routes/auditEvents.js";
import { zatcaRouter } from "./routes/zatca.js";
import { platformZatcaRouter } from "./routes/platformZatca.js";
import { platformAuthRouter } from "./routes/platformAuth.js";
import { platformOrganizationsRouter } from "./routes/platformOrganizations.js";
import { platformSupportSessionsRouter } from "./routes/platformSupportSessions.js";
import { platformAuditEventsRouter } from "./routes/platformAuditEvents.js";
import { requireAuth } from "./middleware/auth.js";
import { platformAuth } from "./middleware/platformAuth.js";
import { uploadsDir } from "./lib/uploads.js";
import { logger } from "./lib/logger.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { errorEnvelopeMiddleware } from "./middleware/errorEnvelope.js";
import { requestLogMiddleware } from "./middleware/requestLog.js";
import { healthRouter } from "./routes/health.js";
import { buildCorsOptions } from "./lib/corsOrigins.js";

export function buildApp() {
  const app = express();
  // MIDAD Phase B — mounted first, ahead of cors/json parsing, so every
  // request gets a correlation id and a diagnostic trace regardless of how
  // far it gets (including a rejected CORS preflight or a malformed JSON
  // body). See each middleware's own file for what it does.
  app.use(requestIdMiddleware);
  app.use(errorEnvelopeMiddleware);
  app.use(requestLogMiddleware);
  // Production launch hardening — no CSP: this server never serves HTML (it
  // is a pure JSON API plus PDF/logo binary responses), so a document-level
  // policy like CSP has nothing to apply to and forcing one on would be
  // exactly the kind of blind policy this hardening pass was told not to
  // add. Every other Helmet default (X-Content-Type-Options, Referrer-Policy,
  // frameguard, etc.) is safe here and left on.
  app.use(helmet({ contentSecurityPolicy: false }));
  // CORS_ORIGIN is unset by default (local dev, CI, and every existing test
  // never set it), so this is cors(undefined) — identical to the previous
  // cors() call, zero behavior change until a real deployment sets it to
  // its actual frontend origin(s). See lib/corsOrigins.ts.
  app.use(cors(buildCorsOptions(process.env.CORS_ORIGIN)));
  app.use(express.json());
  // Local-disk logo storage — see lib/uploads.ts for why this is a stopgap.
  app.use("/uploads", express.static(uploadsDir));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/health", healthRouter);

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
  app.use("/api/audit-events", requireAuth, auditEventsRouter);
  // MIDAD ZATCA e-invoicing (Slice 3) — tenant-scoped configuration and
  // connection API. See routes/zatca.ts's own file comment.
  app.use("/api/zatca", requireAuth, zatcaRouter);

  // MIDAD Phase D1 — PLATFORM_SCOPE, structurally separate from every
  // route above: platformAuthRouter is unauthenticated (it IS the login
  // surface, mirroring authRouter's own mount above); platformOrganizations
  // is gated by platformAuth, never requireAuth — no route in this pair
  // ever passes through requireAuth or sets req.userId/req.companyId.
  app.use("/api/platform/auth", platformAuthRouter);
  app.use("/api/platform/organizations", platformAuth, platformOrganizationsRouter);
  // MIDAD Phase D2 — requireSupportSession (applied per-route inside this
  // router, only on the one route that actually reads tenant data) runs
  // after platformAuth, so req.platformOperatorId is already set when it
  // looks up the session's ownership.
  app.use("/api/platform/support-sessions", platformAuth, platformSupportSessionsRouter);
  // MIDAD Admin Dashboard — self-scoped to req.platformOperatorId only (see
  // routes/platformAuditEvents.ts and lib/audit.ts's
  // listPlatformOperatorActivity); never a second audit store.
  app.use("/api/platform/audit-events", platformAuth, platformAuditEventsRouter);
  // MIDAD ZATCA Admin Dashboard (Slice 3) — read-only, sanitized, never a
  // secret or raw credential value. See routes/platformZatca.ts.
  app.use("/api/platform/zatca", platformAuth, platformZatcaRouter);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error("unhandled_error", {
      requestId: req.requestId,
      message: err.message,
      name: err.name,
      path: req.path,
      method: req.method,
    });
    res.status(500).json({ error: "حدث خطأ غير متوقع في الخادم" });
  });

  return app;
}
