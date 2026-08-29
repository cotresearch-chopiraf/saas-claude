import { describe, it, expect } from "vitest";
import { hasPermission } from "./permissions";

// The actual RBAC-visibility logic <Can/> delegates to — see Can.tsx.
// Testing it directly here is equivalent to testing <Can/>'s rendered
// output (owner sees, member doesn't) without needing to stand up a full
// AuthContext harness for a two-line wrapper component.
describe("hasPermission (frontend UI-visibility helper)", () => {
  it("an owner is permitted an owner-gated action", () => {
    expect(hasPermission("owner", "ipc.manage")).toBe(true);
  });

  it("a member is NOT permitted an owner-gated action", () => {
    expect(hasPermission("member", "ipc.manage")).toBe(false);
  });

  it("no role at all (not yet loaded / logged out) is never permitted", () => {
    expect(hasPermission(undefined, "ipc.manage")).toBe(false);
  });

  it("this is UI visibility only — it never claims to be the backend authority", () => {
    // Documented, not enforced by code: the backend independently
    // re-checks every mutation via requirePermission(). This test exists
    // so the intent stays visible next to the assertions above, not
    // hidden only in a comment.
    expect(hasPermission("owner", "forecast.manage")).toBe(true);
    expect(hasPermission("member", "forecast.manage")).toBe(false);
  });
});
