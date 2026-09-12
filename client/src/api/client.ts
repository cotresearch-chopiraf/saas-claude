import { translateStatic } from "../i18n/I18nProvider";

const TOKEN_KEY = "contractor_os_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Carries the HTTP status alongside the message so a caller can tell a
// genuine auth failure (401) apart from a transient one (429/500/...) —
// see auth/AuthContext.tsx's session-error classification.
//
// `category` is optional and undefined for every non-ZATCA route (none of
// them send one) — populated only when the JSON error body carries a
// `category` string, as ZATCA's routes do (see server/src/lib/zatca/errors.ts's
// ZatcaErrorCategory). Never invented client-side; passed through exactly
// as the backend sent it, same convention as every other field in this
// codebase's API responses. See lib/zatcaErrors.ts for how the ZATCA
// Onboarding & Compliance Center maps this into customer-facing guidance.
export class ApiError extends Error {
  status: number;
  category?: string;
  constructor(message: string, status: number, category?: string) {
    super(message);
    this.status = status;
    this.category = category;
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...options, headers });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body.error ?? translateStatic("common.errorGeneric"), res.status, typeof body.category === "string" ? body.category : undefined);
  }
  return body as T;
}
