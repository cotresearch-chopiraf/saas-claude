import type { Request } from "express";
import rateLimit from "express-rate-limit";

// Same test-environment reasoning as AUTH_RATE_LIMIT_MAX below, generalized
// so every limiter in this file scales the same way under vitest's one
// -shared-process-per-file test runs (see that constant's own comment) —
// production and development are never affected by this function.
function limitFor(productionMax: number, testMax: number): number {
  return process.env.NODE_ENV === "test" ? testMax : productionMax;
}

// 10 attempts per 15 minutes per IP in development and production — enough
// headroom for a real user who mistypes a password a few times, tight
// enough to blunt credential guessing. Never relaxed outside the test
// environment.
//
// AC-05 — in the test environment only, this is raised to a much larger
// but still finite number. vitest runs every test file's HTTP requests
// through one shared Express app instance per file (fileParallelism is
// off; see vitest.config.ts), so a single file that legitimately makes
// several dozen /api/auth/* calls across unrelated describe blocks (e.g.
// tests/concurrency.test.ts) would otherwise trip the production limit and
// fail deterministic tests for a reason that has nothing to do with the
// behavior under test. The RATE_LIMITED path itself stays real and under
// test — see tests/observabilityRateLimit.test.ts, which loops past this
// same exported limit rather than a hardcoded guess. This is the only
// place NODE_ENV is consulted for rate limiting; nothing here touches
// development or production.
export const AUTH_RATE_LIMIT_MAX = process.env.NODE_ENV === "test" ? 100 : 10;

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "محاولات كثيرة جداً، الرجاء المحاولة لاحقاً" },
});

// Real ZATCA submissions have a cost/quota at the provider — an unbounded
// retry loop against POST /submissions/:id/submit could exhaust it or get
// the whole company temporarily blocked by ZATCA, which authRateLimit
// (auth-routes only) never covered. Keyed by companyId, not IP: the actual
// resource being protected is the company's own ZATCA quota, and req.userId
// already went through requireAuth by the time this runs (see app.ts's
// `requireAuth, zatcaRouter` mount), so every member of a company shares
// one budget instead of each getting their own by switching IPs. 30/15min
// is a conservative engineering default (no official ZATCA rate is
// published anywhere this project could verify — see docs/zatca/) chosen
// to comfortably cover a real batch of legitimate submissions while still
// bounding a runaway retry loop or a compromised account.
export const ZATCA_SUBMIT_RATE_LIMIT_MAX = limitFor(30, 300);

export const zatcaSubmitRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: ZATCA_SUBMIT_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.companyId ?? req.ip ?? "unknown",
  message: { error: "عدد كبير جداً من محاولات إرسال ZATCA، الرجاء المحاولة لاحقاً" },
});

// ZATCA Customer Onboarding & Compliance Center — the onboarding routes
// (CSR generation, Compliance CSID request, Compliance Invoice test
// submission, Production CSID onboarding/renewal, connection check) all
// make a real outbound call to ZATCA/FATOORA and, for the OTP-bearing
// ones, carry the same "wrong OTP" guessing exposure zatcaSubmitRateLimit
// was built to bound for /submit — before this, none of them had any
// limiter at all (a customer-onboarding gap confirmed by the ZATCA Live
// Sandbox Verification audit). Same keying/window/shape as
// zatcaSubmitRateLimit (per-company, not per-IP — the resource being
// protected is the company's own ZATCA quota/standing) but a separate,
// slightly higher ceiling: unlike /submit (a per-invoice, potentially
// high-volume operation), onboarding is a handful of one-time-per-EGS-unit
// steps, so a lower number would risk blocking a legitimate multi-EGS-unit
// or multi-attempt real onboarding session; kept well below an abuse-scale
// volume regardless.
export const ZATCA_ONBOARDING_RATE_LIMIT_MAX = limitFor(20, 200);

export const zatcaOnboardingRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: ZATCA_ONBOARDING_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.companyId ?? req.ip ?? "unknown",
  message: { error: "عدد كبير جداً من محاولات إعداد ZATCA، الرجاء المحاولة لاحقاً" },
});

// Public, unauthenticated document links (a client viewing/downloading a
// quote or invoice via its publicToken, no login) — currently the only
// customer-facing routes with no rate limit of any kind. The token itself
// is a random 32-byte value (lib/tokens.ts), not brute-forceable in any
// practical sense; this is coarse abuse/scraping protection, not a
// brute-force defense, hence the much higher ceiling than authRateLimit.
export const PUBLIC_DOCUMENT_RATE_LIMIT_MAX = limitFor(60, 600);

export const publicDocumentRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: PUBLIC_DOCUMENT_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "عدد كبير جداً من الطلبات، الرجاء المحاولة لاحقاً" },
});
