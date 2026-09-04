// drizzle-orm (as of 0.36+) wraps every raw `pg` driver error in its own
// DrizzleQueryError, moving the original error (with its Postgres-specific
// `code`/`constraint` fields) onto `.cause` instead of throwing it directly.
// Call sites across this codebase detect specific SQLSTATE violations (e.g.
// 23505 unique_violation) to distinguish an expected concurrency race from
// a real failure — this helper looks in both places so that detection
// keeps working regardless of which drizzle-orm version is in use.
export function pgErrorInfo(err: unknown): { code?: unknown; constraint?: unknown } {
  if (typeof err !== "object" || err === null) return {};
  const direct = err as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (direct.code !== undefined) return direct;
  if (typeof direct.cause === "object" && direct.cause !== null) {
    return direct.cause as { code?: unknown; constraint?: unknown };
  }
  return {};
}
