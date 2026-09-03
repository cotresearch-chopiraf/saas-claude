// Slice Z — one shared graceful-shutdown sequence for SIGTERM and SIGINT:
// stop accepting new connections (server.close — Node's http.Server keeps
// existing in-flight requests running and only refuses new ones), then
// close the database pool, all bounded by a timeout so a stuck connection
// can never hang the process indefinitely. Exported as a plain factory
// function (not wired directly to process.on) specifically so it can be
// exercised in isolation by a test with fake server/pool objects, rather
// than by sending real OS signals to the test process — the master
// prompt's own instruction: "if direct signal testing is unsafe... verify
// shutdown through isolated integration logic."
import { logger } from "./logger.js";

export interface ShutdownableServer {
  close(callback: (err?: Error) => void): void;
}

export interface ShutdownablePool {
  end(): Promise<void>;
}

export interface GracefulShutdownDeps {
  server: ShutdownableServer;
  pool: ShutdownablePool;
  // Bounded shutdown window — defaults to 10s, generous enough for a real
  // in-flight request to finish, short enough that an orchestrator's own
  // forced-kill timeout (commonly 30s) is never the thing that actually
  // ends the process.
  timeoutMs?: number;
}

export function createGracefulShutdown({ server, pool, timeoutMs = 10_000 }: GracefulShutdownDeps) {
  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    // Idempotent: SIGTERM and SIGINT could in principle both fire, or the
    // same signal could arrive twice — only the first call actually closes
    // anything, later calls are a safe no-op rather than a double-close.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_started", { signal });

    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn("shutdown_timed_out", { signal, timeoutMs });
        resolve();
      }, timeoutMs);
      // Never let this bounding timer itself keep the process alive if the
      // real close sequence already finished and the event loop is
      // otherwise empty.
      timer.unref();
    });

    const closeSequence = (async () => {
      await new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) logger.error("shutdown_http_close_error", { message: err.message });
          resolve();
        });
      });

      try {
        await pool.end();
      } catch (err) {
        logger.error("shutdown_pool_close_error", { message: err instanceof Error ? err.message : "unknown error" });
      }

      logger.info("shutdown_complete", { signal });
    })();

    await Promise.race([closeSequence, timeout]);
  };
}
