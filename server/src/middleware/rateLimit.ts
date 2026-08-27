import rateLimit from "express-rate-limit";

// 10 attempts per 15 minutes per IP — enough headroom for a real user who
// mistypes a password a few times, tight enough to blunt credential guessing.
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "محاولات كثيرة جداً، الرجاء المحاولة لاحقاً" },
});
