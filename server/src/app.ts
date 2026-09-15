// Must be the first import: patches Express so a rejected promise inside an
// async route handler is forwarded to the error middleware instead of
// crashing the whole process (Express 4 doesn't do this natively — a single
// malformed request, e.g. a non-UUID :id hitting Postgres, used to take the
// entire server down for every concurrent user).
import "express-async-errors";
import path from "node:path";
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
import { employeesRouter } from "./routes/employees.js";
import { payrollPeriodsRouter } from "./routes/payrollPeriods.js";
import { payrollRecordsRouter } from "./routes/payrollRecords.js";
import { laborAllocationsRouter } from "./routes/laborAllocations.js";
import { laborCostPostingsRouter } from "./routes/laborCostPostings.js";
import { laborCostRouter } from "./routes/laborCost.js";
import { commitmentsRouter } from "./routes/commitments.js";
import { measurementsRouter } from "./routes/measurements.js";
import { ipcsRouter } from "./routes/ipcs.js";
import { subcontractIpcsRouter } from "./routes/subcontractIpcs.js";
import { subcontractIpcDocumentsRouter } from "./routes/subcontractIpcDocuments.js";
import { forecastRouter } from "./routes/forecast.js";
import { cashflowRouter } from "./routes/cashflow.js";
import { documentsRouter } from "./routes/documents.js";
import { projectScheduleRouter } from "./routes/projectSchedule.js";
import { punchItemsRouter } from "./routes/punchItems.js";
import { workforceComplianceRouter } from "./routes/workforceCompliance.js";
import { budgetAlertsRouter } from "./routes/budgetAlerts.js";
import { auditEventsRouter } from "./routes/auditEvents.js";
import { notificationsRouter } from "./routes/notifications.js";
import { zatcaRouter } from "./routes/zatca.js";
import { platformZatcaRouter } from "./routes/platformZatca.js";
import { platformAuthRouter } from "./routes/platformAuth.js";
import { platformOrganizationsRouter } from "./routes/platformOrganizations.js";
import { platformSupportSessionsRouter } from "./routes/platformSupportSessions.js";
import { platformAuditEventsRouter } from "./routes/platformAuditEvents.js";
import { featureFlagsRouter } from "./routes/featureFlags.js";
import { platformFeatureFlagsRouter } from "./routes/platformFeatureFlags.js";
import { platformPlansRouter } from "./routes/platformPlans.js";
import { platformSecurityRouter } from "./routes/platformSecurity.js";
import { platformOwnershipTransferRouter } from "./routes/platformOwnershipTransfer.js";
import { platformTenantExportRouter, platformTenantImportRouter } from "./routes/platformTenantData.js";
import { platformBackupCenterRouter } from "./routes/platformBackupCenter.js";
import { platformIncidentsRouter } from "./routes/platformIncidents.js";
import { platformHandoverRouter } from "./routes/platformHandover.js";
import { clientPortalUsersRouter } from "./routes/clientPortalUsers.js";
import { clientPortalAuthRouter } from "./routes/clientPortalAuth.js";
import { clientPortalProjectsRouter } from "./routes/clientPortalProjects.js";
import { clientPortalDocumentsRouter } from "./routes/clientPortalDocuments.js";
import { requireAuth } from "./middleware/auth.js";
import { platformAuth } from "./middleware/platformAuth.js";
import { clientPortalAuth } from "./middleware/clientPortalAuth.js";
import { requireClientProjectAccess } from "./middleware/requireClientProjectAccess.js";
import { uploadsDir } from "./lib/uploads.js";
import { logger } from "./lib/logger.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { errorEnvelopeMiddleware } from "./middleware/errorEnvelope.js";
import { requestLogMiddleware } from "./middleware/requestLog.js";
import { healthRouter } from "./routes/health.js";
import { buildCorsOptions } from "./lib/corsOrigins.js";

// 18-phase internal remediation, Phase 3 — this codebase never called
// app.set("trust proxy", ...) at all (confirmed by a repo-wide audit
// grep), so Express's own default (trust proxy = false) was silently in
// effect: req.ip is the direct TCP peer, never X-Forwarded-For/-Proto.
// That default is correct for local dev and this test suite (no proxy in
// front), but is a real, self-inflicted bug the moment this runs behind
// any reverse proxy (Railway's included): every request's direct peer
// becomes the proxy itself, so req.ip is constant for every real client —
// middleware/rateLimit.ts's IP-keyed limiters (authRateLimit,
// publicDocumentRateLimit) would collapse into one shared bucket for the
// entire user base instead of one per client.
//
// What is NOT fixed here, deliberately: the correct value (how many
// proxy hops to trust, or which subnets) depends on Railway's actual
// network topology, which this internal-only remediation pass has no way
// to verify — inventing a number would be exactly the kind of guess the
// remediation's own rules forbid. What IS fixed: the value is now
// env-driven, so a deploy can set it correctly without another code
// change, and — critically — leaving TRUST_PROXY unset reproduces
// Express's exact prior default (this function makes no app.set() call
// at all in that case), so no test or local-dev behavior changes.
function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  const asNumber = Number(value);
  if (Number.isInteger(asNumber) && String(asNumber) === value) return asNumber;
  return value; // e.g. a CSV subnet/address list — Express's own accepted shape
}

export function buildApp() {
  const app = express();
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) {
    app.set("trust proxy", trustProxy);
  }
  // MIDAD Phase B — mounted first, ahead of cors/json parsing, so every
  // request gets a correlation id and a diagnostic trace regardless of how
  // far it gets (including a rejected CORS preflight or a malformed JSON
  // body). See each middleware's own file for what it does.
  app.use(requestIdMiddleware);
  app.use(errorEnvelopeMiddleware);
  app.use(requestLogMiddleware);
  // CSP hardening — the A1-era comment this replaced left CSP off pending
  // real-browser verification of every page under an enforced policy
  // (static reading the client source is not the same bar as an actual
  // enforced run). That verification has now been done: a dedicated
  // read-only security audit built the production client, drove it with
  // Playwright under exactly the policy below (injected as a real response
  // header, server untouched), and exercised /, /settings (including the
  // company-logo <img>), /projects, /invoices, /quotes on a real logged-in
  // session — zero `securitypolicyviolation` events, zero console errors.
  // That matches the static read: no inline script/style, no eval/new
  // Function, no external script/font/API host anywhere in the client
  // source (see client/dist/index.html — one same-origin <script
  // type="module">, one same-origin stylesheet). `img-src` includes
  // `data:` and `blob:` for the PDF-download blob-URL pattern used
  // throughout the client (createObjectURL -> <a download> -> revoke) and
  // any data-URI image preview; nothing here needed `'unsafe-inline'` or
  // `'unsafe-eval'`, and none is added. `object-src 'none'` and
  // `frame-ancestors 'self'` are additive hardening beyond what was
  // strictly required to pass the browser check.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
        },
      },
    }),
  );
  // 18-phase internal remediation, Phase 5 — Permissions-Policy was the one
  // gap the CSP/headers audit found: Helmet 8 dropped its own
  // permissionsPolicy() middleware (the spec was still changing), so this
  // is set directly. The client never requests any of these browser
  // features (grepped client/src for camera/microphone/geolocation/
  // payment/usb APIs — no matches), so every one is disabled outright
  // rather than scoped to 'self': there is no legitimate same-origin use
  // to preserve, and disabling denies even a future same-origin bug from
  // invoking them.
  app.use((_req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    );
    next();
  });
  // CORS_ORIGIN is unset by default (local dev, CI, and every existing test
  // never set it), so outside production this is cors(undefined) —
  // identical to the previous cors() call, zero behavior change until a
  // real deployment sets it to its actual frontend origin(s). In production
  // buildCorsOptions() throws instead of silently falling back to
  // permissive CORS if CORS_ORIGIN isn't set — see lib/corsOrigins.ts.
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
  // MIDAD Phase C1 — Gantt Scheduling Foundation. Deliberately its own
  // path segment ("schedule"), not "tasks" — /api/projects/:projectId/tasks
  // already belongs to Slice AA's unrelated flat to-do-checklist table.
  app.use("/api/projects/:projectId/schedule", requireAuth, projectScheduleRouter);
  // MIDAD Phase C2 — Punch Lists / Site Deficiencies. INTERNAL ONLY — no
  // route in this router is ever mounted under /api/portal/*, and it never
  // will be without a separate, explicitly scoped future phase.
  app.use("/api/projects/:projectId/punch-items", requireAuth, punchItemsRouter);
  // MIDAD Phase D1 — Nitaqat + GOSI Compliance Tracking Foundation.
  // Deliberately NOT under /api/compliance — that prefix already belongs
  // to the tax/ZATCA compliance domain (routes/compliance.ts). Company-
  // wide (not project-scoped), matching employees/payroll-periods' own
  // mount pattern. INTERNAL ONLY — never mounted under /api/portal/*.
  app.use("/api/workforce-compliance", requireAuth, workforceComplianceRouter);
  // MIDAD Phase E — Proactive Budget Overrun Alerts. Company-wide (not
  // project-scoped), same mount pattern as workforce-compliance: alerts
  // span multiple projects for the dashboard's cross-project view. INTERNAL
  // ONLY — never mounted under /api/portal/*.
  app.use("/api/budget-alerts", requireAuth, budgetAlertsRouter);
  app.use("/api/cost-codes", requireAuth, costCodesRouter);
  app.use("/api/suppliers", requireAuth, suppliersRouter);
  app.use("/api/customers", requireAuth, customersRouter);
  // MIDAD Phase A2 — Employees (workforce master data). Company-wide, not
  // project-scoped, same mount pattern as suppliers/customers above.
  app.use("/api/employees", requireAuth, employeesRouter);
  // MIDAD Phase A3 — Payroll Periods + Records. Company-wide, not
  // project-scoped, same mount pattern as employees above.
  app.use("/api/payroll-periods", requireAuth, payrollPeriodsRouter);
  app.use("/api/payroll-records", requireAuth, payrollRecordsRouter);
  // MIDAD Phase A4 — Labor Allocation (company-wide) + read-only project
  // labor-cost visibility (project-scoped, same mount pattern as
  // forecast/cash-flow above).
  app.use("/api/labor-allocations", requireAuth, laborAllocationsRouter);
  // MIDAD Phase A5 — Financial posting of labor allocations + reversal.
  // Company-wide, same mount pattern as labor-allocations above.
  app.use("/api/labor-cost-postings", requireAuth, laborCostPostingsRouter);
  app.use("/api/projects/:projectId/labor-cost", requireAuth, laborCostRouter);
  app.use("/api/company", requireAuth, companyRouter);
  app.use("/api/quotes", requireAuth, quotesRouter);
  app.use("/api/public/quotes", publicQuotesRouter);
  app.use("/api/invoices", requireAuth, invoicesRouter);
  app.use("/api/public/invoices", publicInvoicesRouter);
  app.use("/api/compliance", requireAuth, complianceRouter);
  app.use("/api/audit-events", requireAuth, auditEventsRouter);
  // Slice AA Scope F — minimal notification foundation. See
  // routes/notifications.ts and lib/notifications.ts for the ownership
  // contract (companyId + recipientUserId, both from the verified JWT).
  app.use("/api/notifications", requireAuth, notificationsRouter);
  // MIDAD ZATCA e-invoicing (Slice 3) — tenant-scoped configuration and
  // connection API. See routes/zatca.ts's own file comment.
  app.use("/api/zatca", requireAuth, zatcaRouter);
  // MIDAD Phase B1 — internal, tenant-side management of Client Portal
  // Users and their project access grants. Ordinary requireAuth mount,
  // same as every other master-data domain above; every mutation inside
  // additionally requires clientPortal.manage (see permissions.ts).
  app.use("/api/client-portal-users", requireAuth, clientPortalUsersRouter);
  // P0 hardening (Final Pre-Launch audit) — tenant-facing read of the
  // caller's own effective feature-flag set. See routes/featureFlags.ts.
  app.use("/api/feature-flags", requireAuth, featureFlagsRouter);

  // MIDAD Phase B1 — CLIENT_PORTAL_SCOPE, structurally separate from every
  // route above (tenant) and below (platform): clientPortalAuthRouter is
  // unauthenticated (it IS the login surface, mirroring authRouter's own
  // mount); clientPortalProjectsRouter is gated by clientPortalAuth, never
  // requireAuth — no route in this pair ever passes through requireAuth or
  // sets req.userId/req.companyId/req.platformOperatorId.
  app.use("/api/portal/auth", clientPortalAuthRouter);
  app.use("/api/portal/projects", clientPortalAuth, clientPortalProjectsRouter);
  // MIDAD Phase B3 — same two-middleware chain as clientPortalProjectsRouter's
  // own GET /:projectId (clientPortalAuth first, then requireClientProjectAccess
  // to resolve the active grant and set req.clientPortalGrantCompanyId), applied
  // at the mount site exactly like documentsRouter's project-ownership check is
  // for the internal /api/projects/:projectId/documents route above.
  app.use(
    "/api/portal/projects/:projectId/documents",
    clientPortalAuth,
    requireClientProjectAccess,
    clientPortalDocumentsRouter,
  );

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
  // P0 hardening (Final Pre-Launch audit) — platform-admin CRUD over the
  // feature-flag registry and per-company overrides. See
  // routes/platformFeatureFlags.ts.
  app.use("/api/platform/feature-flags", platformAuth, platformFeatureFlagsRouter);
  // P0 hardening (Final Pre-Launch audit) — platform-admin CRUD over the
  // plan registry and per-company plan assignment. See
  // routes/platformPlans.ts.
  app.use("/api/platform/plans", platformAuth, platformPlansRouter);
  // MIDAD Final Pre-Launch audit, Phase 7 — Security Center. Read-only,
  // gated by the "security.read" capability. See routes/platformSecurity.ts.
  app.use("/api/platform/security", platformAuth, platformSecurityRouter);
  // MIDAD Final Pre-Launch audit, Phase 9 — Ownership Transfer. Gated by
  // the "ownershipTransfer.manage" capability (platform_owner only). See
  // routes/platformOwnershipTransfer.ts.
  app.use("/api/platform/ownership-transfer", platformAuth, platformOwnershipTransferRouter);
  // MIDAD Final Pre-Launch audit, Phase 10-11 — Tenant Export/Import. The
  // export router shares /api/platform/organizations with
  // platformOrganizationsRouter (it only adds /:id/export, no collision)
  // rather than inventing a separate base path for one route. See
  // routes/platformTenantData.ts and lib/tenantExport.ts/tenantImport.ts.
  app.use("/api/platform/organizations", platformAuth, platformTenantExportRouter);
  app.use("/api/platform/tenant-import", platformAuth, platformTenantImportRouter);
  // MIDAD Final Pre-Launch audit, Phase 12 — Platform Backup Center. See
  // routes/platformBackupCenter.ts and lib/backupStatus.ts.
  app.use("/api/platform/backup-center", platformAuth, platformBackupCenterRouter);
  // MIDAD Final Pre-Launch audit, Phase 13 — Observability/Incident
  // Center. Manual creation/tracking only, gated by "incidents.read"/
  // "incidents.manage". See routes/platformIncidents.ts.
  app.use("/api/platform/incidents", platformAuth, platformIncidentsRouter);
  // MIDAD Final Pre-Launch audit, Phase 17 — Sale/Handover Center. See
  // routes/platformHandover.ts.
  app.use("/api/platform/handover", platformAuth, platformHandoverRouter);

  // A1 remediation — single-origin frontend serving. Registered AFTER every
  // /api/* mount and /uploads above (Express matches middleware in
  // registration order, so a real API/upload request is always satisfied by
  // its own route first and never reaches this point). clientDistDir is
  // resolved the same process.cwd()-relative way lib/storage/localDiskProvider.ts
  // already resolves uploadsDir — WORKDIR is the server/ directory both in
  // local dev (npm workspaces sets cwd to the workspace root) and in the
  // Docker runtime image (WORKDIR /app/server), so "../client/dist"
  // consistently means the client build directory copied alongside it.
  const clientDistDir = path.resolve(process.cwd(), "../client/dist");
  app.use(express.static(clientDistDir));

  // BrowserRouter (client/src/main.tsx) needs a real HTTP 200 + index.html
  // for a direct GET to any client-side route (a deep link, a bookmark, or
  // a page refresh on e.g. /projects/:id/boq) — without this, such a
  // request 404s before React Router ever loads, since no server route
  // matches that literal path. Deliberately not a bare app.get("*", ...):
  // the negative-lookahead regex excludes any path starting with "/api/"
  // or "/api" (exact) and "/uploads/" or "/uploads" (exact) — a request to
  // an *unmatched* API route must still fall through to the ordinary
  // Express 404 (and this app's own global error handler below), never
  // silently receive the SPA shell instead.
  app.get(/^\/(?!(api|uploads)(\/|$)).*/, (_req, res) => {
    res.sendFile(path.join(clientDistDir, "index.html"));
  });

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
