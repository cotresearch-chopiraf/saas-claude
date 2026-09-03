import "dotenv/config";
import { validateStartupConfig, StartupConfigError } from "./lib/startupConfig.js";
import { logger } from "./lib/logger.js";
import { createGracefulShutdown } from "./lib/shutdown.js";

// Slice Z — validate required configuration before anything that depends
// on it (buildApp -> routes -> db/client.ts's Pool construction) is even
// imported. A dynamic import() genuinely defers module evaluation until
// this point at runtime — unlike a static `import { buildApp } from
// "./app.js"` at the top of the file, which ES modules would evaluate
// before this function body ever runs, regardless of where it's written
// in the file. This is what makes "missing configuration -> immediate
// failure, before any Pool/connection is attempted" actually true rather
// than aspirational.
async function main(): Promise<void> {
  try {
    validateStartupConfig();
  } catch (err) {
    if (err instanceof StartupConfigError) {
      // Never log err itself (or any env var) — only this class's own
      // message, which names missing variable names, never values.
      logger.error("startup_configuration_invalid", { message: err.message });
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const { buildApp } = await import("./app.js");
  const { pool } = await import("./db/client.js");

  const app = buildApp();
  const port = Number(process.env.PORT ?? 4000);
  const server = app.listen(port, () => {
    logger.info("server_listening", { port });
  });

  const shutdown = createGracefulShutdown({ server, pool });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      shutdown(signal)
        .catch((err) => logger.error("shutdown_unexpected_error", { message: err instanceof Error ? err.message : "unknown error" }))
        .finally(() => process.exit(0));
    });
  }
}

main();
