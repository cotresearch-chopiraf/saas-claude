import { portalApiFetch } from "./portalClient";
import type { ClientPortalUser } from "./types";

export function portalLogin(email: string, password: string): Promise<{ token: string; user: ClientPortalUser }> {
  return portalApiFetch("/portal/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

// Best-effort — the server-side session is authoritative and already
// revoked by this call, but even if it fails (network error, already-
// expired token), the caller clears the local token/user regardless (see
// ClientPortalAuthContext.tsx's own logout()).
export function portalLogout(): Promise<{ message: string }> {
  return portalApiFetch("/portal/auth/logout", { method: "POST" });
}
