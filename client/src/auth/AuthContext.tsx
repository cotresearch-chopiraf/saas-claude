import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch, getToken, setToken } from "../api/client";
import type { Company, User } from "../api/types";

interface AuthState {
  user: User | null;
  company: Company | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (companyName: string, name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    apiFetch<{ user: User; company: Company | null }>("/auth/me")
      .then((res) => {
        setUser(res.user);
        setCompany(res.company);
      })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const res = await apiFetch<{ token: string; user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setToken(res.token);
    setUser(res.user);
  }

  async function register(companyName: string, name: string, email: string, password: string) {
    const res = await apiFetch<{ token: string; user: User; company: Company }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ companyName, name, email, password }),
    });
    setToken(res.token);
    setUser(res.user);
    setCompany(res.company);
  }

  function logout() {
    setToken(null);
    setUser(null);
    setCompany(null);
  }

  return (
    <AuthContext.Provider value={{ user, company, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
