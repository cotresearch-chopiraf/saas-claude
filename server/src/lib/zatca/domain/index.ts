// MIDAD ZATCA domain layer (Slice 2) — tenant-scoped persistence for EGS
// units, ICV counters, PIH pointers, and submission records. Every
// function requires companyId as a mandatory first argument, sourced only
// from a server-verified tenant context (req.companyId) — never from
// client-supplied input. No route in this codebase calls into this module
// yet; see docs/ZATCA_IMPLEMENTATION_STATUS.md.

export * from "./egsUnits.js";
export * from "./icv.js";
export * from "./pih.js";
export * from "./submissions.js";
