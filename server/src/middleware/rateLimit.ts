import rateLimit from "express-rate-limit";

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
