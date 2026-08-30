import { createContext, useContext, useState, type ReactNode } from "react";
import { getPlatformToken, setPlatformToken } from "../api/platformClient";
import { platformLogin as platformLoginRequest } from "../api/platformAuth";
import type { PlatformOperator } from "../api/types";

// MIDAD — Platform Admin Console (client for D1/D2) — the platform-side mirror of ../../auth/
// AuthContext.tsx, deliberately a completely separate context/provider: a
// PlatformOperator is never a tenant User, and this must never be
// reachable from (or confused with) useAuth()/AuthContext.
//
// No GET /api/platform/auth/me endpoint exists (D1 didn't build one, and
// this slice doesn't need to add one) — the operator's id/name/email
// already come back from the login response itself, so both token and
// operator are persisted together and restored directly on mount, with no
// extra round trip. This is presentation state only, exactly like
// AuthContext's own user/company state: the server independently
// re-verifies the operator's status from the database on every real
// request (middleware/platformAuth.ts) regardless of what this context
// believes.
const OPERATOR_STORAGE_KEY = "midad_platform_operator";

interface PlatformAuthState {
  operator: PlatformOperator | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const PlatformAuthContext = createContext<PlatformAuthState | undefined>(undefined);

function loadStoredOperator(): PlatformOperator | null {
  if (!getPlatformToken()) return null;
  try {
    const raw = localStorage.getItem(OPERATOR_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PlatformOperator) : null;
  } catch {
    return null;
  }
}

export function PlatformAuthProvider({ children }: { children: ReactNode }) {
  const [operator, setOperator] = useState<PlatformOperator | null>(loadStoredOperator);

  async function login(email: string, password: string) {
    const res = await platformLoginRequest(email, password);
    setPlatformToken(res.token);
    localStorage.setItem(OPERATOR_STORAGE_KEY, JSON.stringify(res.operator));
    setOperator(res.operator);
  }

  function logout() {
    setPlatformToken(null);
    localStorage.removeItem(OPERATOR_STORAGE_KEY);
    setOperator(null);
  }

  return (
    <PlatformAuthContext.Provider value={{ operator, loading: false, login, logout }}>
      {children}
    </PlatformAuthContext.Provider>
  );
}

export function usePlatformAuth(): PlatformAuthState {
  const ctx = useContext(PlatformAuthContext);
  if (!ctx) throw new Error("usePlatformAuth must be used within a PlatformAuthProvider");
  return ctx;
}
