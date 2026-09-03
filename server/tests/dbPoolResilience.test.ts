import { describe, it, expect, vi, afterEach } from "vitest";
import { pool } from "../src/db/client.js";
import { logger } from "../src/lib/logger.js";

// Slice Z — proves the specific requirement: a Postgres pool "error" event
// (a transient blip on an idle pooled connection) is handled, not left to
// become an uncaught EventEmitter exception that crashes the process. This
// reuses the same shared `pool` every other test file in this suite
// already imports (via `db`) — emitting a synthetic error event on it here
// is safe and has no effect on any other test's queries, since Node's
// EventEmitter "error" event is just a normal event dispatch to whatever
// listeners are registered, not a real connection failure.
describe("Slice Z — Postgres pool resilience", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a listener is registered for the pool's 'error' event", () => {
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
  });

  it("emitting a pool error is logged via the structured logger and never throws", () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    expect(() => {
      pool.emit("error", new Error("simulated transient connection error"));
    }).not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(
      "postgres_pool_error",
      expect.objectContaining({ message: "simulated transient connection error" }),
    );
  });

  it("never logs connection-string/credential material for a pool error", () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    pool.emit("error", new Error("connection refused"));
    const loggedMeta = errorSpy.mock.calls[0]?.[1];
    expect(JSON.stringify(loggedMeta ?? {})).not.toMatch(/postgres:\/\//);
  });
});
