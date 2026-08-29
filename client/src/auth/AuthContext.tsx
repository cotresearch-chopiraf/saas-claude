import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch, ApiError, getToken, setToken } from "../api/client";
import type { Company, User } from "../api/types";

interface AuthState {
  user: User | null;
  company: Company | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (companyName: string, name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  // The one canonical way to (re)synchronize user/role state from /auth/me
  // — exposed so any flow that establishes a token outside login/register
  // (e.g. AcceptInvite) reuses this instead of parsing its own partial
  // response into a second, ad hoc source of truth. Rethrows on failure so
  // the caller decides what to do (login/register already awaited this
  // internally before this was exposed; AcceptInvite now does the same).
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);

  // The single place user/company state is populated from, always via
  // /auth/me — the only response that carries role. /auth/login and
  // /auth/register are left untouched (their own response shapes are
  // unrelated auth behavior, out of scope here); this just avoids trusting
  // either endpoint's partial user object instead of that one canonical
  // source, so role is never missing right after login/register.
  async function refreshUser() {
    const res = await apiFetch<{ user: User; company: Company | null }>("/auth/me");
    setUser(res.user);
    setCompany(res.company);
  }

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    refreshUser()
      .catch((err) => {
        // Only a genuine 401 proves the credential itself is invalid (the
        // token is missing, malformed, or expired — see requireAuth in
        // server/src/middleware/auth.ts). Anything else — 429 (rate
        // limited), 500, a network failure, a timeout — is a failed
        // *check*, not proof of an invalid session, and must never clear a
        // token that may still be perfectly valid. user/company simply
        // stay null in that case; loading still resolves so the app isn't
        // stuck, but no authenticated state is fabricated either.
        if (err instanceof ApiError && err.status === 401) {
          setToken(null);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const res = await apiFetch<{ token: string; user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setToken(res.token);
    await refreshUser();
  }

  async function register(companyName: string, name: string, email: string, password: string) {
    const res = await apiFetch<{ token: string; user: User; company: Company }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ companyName, name, email, password }),
    });
    setToken(res.token);
    await refreshUser();
  }

  function logout() {
    setToken(null);
    setUser(null);
    setCompany(null);
  }

  return (
    <AuthContext.Provider value={{ user, company, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
