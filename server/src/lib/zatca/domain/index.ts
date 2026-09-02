// MIDAD ZATCA domain layer — tenant-scoped persistence for EGS units, ICV
// counters, PIH pointers, submission records, and (Slice 3) tenant
// identity configuration. Every function requires companyId as a
// mandatory first argument, sourced only from a server-verified tenant
// context (req.companyId) — never from client-supplied input. Consumed by
// routes/zatca.ts (tenant-scoped) and routes/platformZatca.ts (read-only,
// platform-scoped) as of Slice 3.

export * from "./egsUnits.js";
export * from "./icv.js";
export * from "./pih.js";
export * from "./submissions.js";
export * from "./config.js";
export * from "./onboarding.js";
export * from "./invoiceLookup.js";
export * from "./csr.js";
export * from "./csrInstances.js";
export * from "./complianceLifecycles.js";
export * from "./complianceCsid.js";
export * from "./complianceAttempts.js";
export * from "./complianceInvoice.js";
