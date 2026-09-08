import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Phase 3.2 P0 remediation (LOGIN-001) — db:seed creates a
// publicly-documented demo account (README.md) and must never run against
// a database holding real customer data. This runs the REAL script
// (`tsx src/db/seed.ts`, exactly what `npm run db:seed --workspace server`
// invokes), not a copy of its guard logic, so a future edit that
// accidentally removes or bypasses the check fails this test.
//
// DATABASE_URL is deliberately set to an address nothing is listening on:
// if the guard fires first (as it must), the process never attempts a
// connection and the only error is the guard's own message. If the guard
// were ever removed or reordered after the first DB call, this test would
// instead see a connection-refused error and fail on the message
// assertion below — so this also proves the guard runs BEFORE any
// database write, not just that it exists somewhere in the file.
describe("db:seed production guard", () => {
  it("refuses to run with NODE_ENV=production, before touching the database", () => {
    const repoRoot = path.resolve(__dirname, "../..");
    const serverRoot = path.resolve(__dirname, "..");
    const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

    let failed = false;
    let stderr = "";
    let status: number | null = 0;
    try {
      execFileSync(tsxBin, ["src/db/seed.ts"], {
        cwd: serverRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
          DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/nonexistent",
        },
        stdio: "pipe",
      });
    } catch (err) {
      failed = true;
      const e = err as { status?: number | null; stderr?: Buffer };
      status = e.status ?? null;
      stderr = e.stderr?.toString() ?? "";
    }

    expect(failed).toBe(true);
    expect(status).not.toBe(0);
    expect(stderr).toContain("db:seed refuses to run with NODE_ENV=production");
    // Proves the guard fired before any connection attempt — a pg
    // connection error would look nothing like this.
    expect(stderr).not.toMatch(/ECONNREFUSED|password authentication|getaddrinfo/i);
  }, 30000);
});
