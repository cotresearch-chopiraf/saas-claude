import { createContext, useContext, useState, type ReactNode } from "react";
import { getPortalToken, setPortalToken } from "../api/portalClient";
import { portalLogin as portalLoginRequest, portalLogout as portalLogoutRequest } from "../api/portalAuth";
import type { ClientPortalUser } from "../api/types";

// MIDAD Phase B1/B2 — Client Portal — the portal-side mirror of
// ../../platform/auth/PlatformAuthContext.tsx, deliberately a completely
// separate context/provider: a Client Portal User is never a tenant User
// or a PlatformOperator, and this must never be reachable from (or
// confused with) useAuth()/usePlatformAuth().
//
// No GET /api/portal/auth/me endpoint exists (B1 didn't build one, and
// this slice doesn't need to add one) — the portal user's id/name/email
// already come back from the login response itself, so both token and
// user are persisted together and restored directly on mount, with no
// extra round trip. This is presentation state only, exactly like
// PlatformAuthContext's own operator state: the server independently
// re-verifies the session/account status from the database on every real
// request (middleware/clientPortalAuth.ts) regardless of what this
// context believes — a revoked session or disabled account still gets
// rejected by the very next API call even if this state hasn't caught up
// yet (see PortalProtectedRoute/pages' own 401 handling).
const PORTAL_USER_STORAGE_KEY = "midad_portal_user";

interface ClientPortalAuthState {
  portalUser: ClientPortalUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const ClientPortalAuthContext = createContext<ClientPortalAuthState | undefined>(undefined);

function loadStoredPortalUser(): ClientPortalUser | null {
  if (!getPortalToken()) return null;
  try {
    const raw = localStorage.getItem(PORTAL_USER_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ClientPortalUser) : null;
  } catch {
    return null;
  }
}

export function ClientPortalAuthProvider({ children }: { children: ReactNode }) {
  const [portalUser, setPortalUser] = useState<ClientPortalUser | null>(loadStoredPortalUser);

  async function login(email: string, password: string) {
    const res = await portalLoginRequest(email, password);
    setPortalToken(res.token);
    localStorage.setItem(PORTAL_USER_STORAGE_KEY, JSON.stringify(res.user));
    setPortalUser(res.user);
  }

  function logout() {
    // Fire-and-forget — local state is cleared regardless of whether the
    // server call succeeds (see portalAuth.ts's own comment on this).
    portalLogoutRequest().catch(() => {});
    setPortalToken(null);
    localStorage.removeItem(PORTAL_USER_STORAGE_KEY);
    setPortalUser(null);
  }

  return (
    <ClientPortalAuthContext.Provider value={{ portalUser, loading: false, login, logout }}>
      {children}
    </ClientPortalAuthContext.Provider>
  );
}

export function useClientPortalAuth(): ClientPortalAuthState {
  const ctx = useContext(ClientPortalAuthContext);
  if (!ctx) throw new Error("useClientPortalAuth must be used within a ClientPortalAuthProvider");
  return ctx;
}
