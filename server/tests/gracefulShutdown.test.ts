import { describe, it, expect, vi } from "vitest";
import { createGracefulShutdown, type ShutdownablePool, type ShutdownableServer } from "../src/lib/shutdown.js";

// Slice Z — tests the shutdown sequence in complete isolation against fake
// server/pool objects. Deliberately never sends a real SIGTERM/SIGINT to
// this test process (that would be exactly the kind of fragile,
// process-global test the master prompt warned against) — the exported
// createGracefulShutdown factory exists specifically so this logic can be
// exercised this way.
describe("Slice Z — graceful shutdown", () => {
  it("closes the HTTP server, then the database pool, then resolves", async () => {
    const closeOrder: string[] = [];
    const server: ShutdownableServer = {
      close: vi.fn((cb: (err?: Error) => void) => {
        closeOrder.push("server");
        cb();
      }),
    };
    const pool: ShutdownablePool = {
      end: vi.fn(async () => {
        closeOrder.push("pool");
      }),
    };

    const shutdown = createGracefulShutdown({ server, pool, timeoutMs: 1000 });
    await shutdown("SIGTERM");

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(closeOrder).toEqual(["server", "pool"]);
  });

  it("is idempotent — concurrent shutdown calls only close resources once", async () => {
    const server: ShutdownableServer = { close: vi.fn((cb: (err?: Error) => void) => cb()) };
    const pool: ShutdownablePool = { end: vi.fn(async () => {}) };

    const shutdown = createGracefulShutdown({ server, pool, timeoutMs: 1000 });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("does not hang indefinitely if the HTTP server never finishes closing — resolves at the bounded timeout", async () => {
    const server: ShutdownableServer = {
      // Simulates a stuck close — the callback is never invoked.
      close: vi.fn(() => {}),
    };
    const pool: ShutdownablePool = { end: vi.fn(async () => {}) };

    const shutdown = createGracefulShutdown({ server, pool, timeoutMs: 50 });
    const startedAt = Date.now();
    await shutdown("SIGTERM");
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
  });

  it("still closes the pool even if server.close reports an error", async () => {
    const server: ShutdownableServer = {
      close: vi.fn((cb: (err?: Error) => void) => cb(new Error("already closed"))),
    };
    const pool: ShutdownablePool = { end: vi.fn(async () => {}) };

    const shutdown = createGracefulShutdown({ server, pool, timeoutMs: 1000 });
    await shutdown("SIGTERM");

    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("does not throw even if pool.end() itself rejects", async () => {
    const server: ShutdownableServer = { close: vi.fn((cb: (err?: Error) => void) => cb()) };
    const pool: ShutdownablePool = {
      end: vi.fn(async () => {
        throw new Error("pool already ended");
      }),
    };

    const shutdown = createGracefulShutdown({ server, pool, timeoutMs: 1000 });
    await expect(shutdown("SIGTERM")).resolves.toBeUndefined();
  });
});
