// Minimal structured logger: one JSON line per event to stdout/stderr, no
// external dependency. Callers must never pass a password, token, secret,
// or other sensitive credential in `meta` — this module does no redaction
// of its own.
type Level = "info" | "warn" | "error";

function write(level: Level, event: string, meta: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...meta });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, meta?: Record<string, unknown>) => write("info", event, meta),
  warn: (event: string, meta?: Record<string, unknown>) => write("warn", event, meta),
  error: (event: string, meta?: Record<string, unknown>) => write("error", event, meta),
};
