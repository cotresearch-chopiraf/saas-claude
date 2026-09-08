import { beforeEach, afterEach } from "vitest";

// P0.5 remediation — every ZATCA test file that needs a valid
// ZATCA_CSR_ECDSA_CURVE now goes through this one helper instead of each
// file managing process.env directly. vitest.config.ts sets
// fileParallelism: false (every test file shares one real Postgres DB, so
// this suite must run in one process, one file at a time — see that
// file's own comment), which means process.env mutations are genuinely
// global across every test file, not scoped to the file that made them.
//
// The previous per-file handling was inconsistent: most files set the
// variable once in beforeAll and never restored it; two files captured
// the "original" value once at module-import time and restored it in
// afterAll/afterEach — a snapshot that depends on exactly when vitest
// imports each file's module graph relative to every other file's own
// hooks having already run, which is not something a single test file can
// control or rely on. One file's afterEach even restored the snapshot and
// then immediately overwrote it back to "P-256" on the next line — a
// leftover bug that happened to mask itself under fileParallelism:false's
// otherwise-forgiving ordering.
//
// This helper closes the whole class of problem regardless of file
// execution order: it snapshots and restores the PRE-TEST value around
// EVERY individual test (beforeEach/afterEach, not beforeAll/afterAll), so
// no test can ever observe a value left over by a previous test in this
// file or by a previous file, and a test that deliberately mutates the
// variable (to exercise an invalid-curve or missing-curve code path) can
// never leak that mutation into the next test or the next file — the next
// beforeEach always re-establishes a known-good value before that test's
// own body runs.
export function useZatcaCsrCurve(curve = "P-256"): void {
  let previousValue: string | undefined;

  beforeEach(() => {
    previousValue = process.env.ZATCA_CSR_ECDSA_CURVE;
    process.env.ZATCA_CSR_ECDSA_CURVE = curve;
  });

  afterEach(() => {
    if (previousValue === undefined) delete process.env.ZATCA_CSR_ECDSA_CURVE;
    else process.env.ZATCA_CSR_ECDSA_CURVE = previousValue;
  });
}
