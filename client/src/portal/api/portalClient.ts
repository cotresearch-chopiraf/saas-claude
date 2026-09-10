import { ApiError } from "../../api/client";

// MIDAD Phase B1/B2 — Client Portal — deliberately its own token key, its
// own storage functions, and its own fetch wrapper: ../../api/client.ts's
// TOKEN_KEY/apiFetch are the tenant session's only storage, and
// ../../platform/api/platformClient.ts's are the platform operator's only
// storage — a Client Portal session must never collide with or be
// readable through either. Same client-side mirror of the server-side
// isolation rule middleware/clientPortalAuth.ts already establishes
// (never mixed with req.userId/req.companyId/req.platformOperatorId).
const PORTAL_TOKEN_KEY = "midad_portal_token";

export function getPortalToken(): string | null {
  return localStorage.getItem(PORTAL_TOKEN_KEY);
}

export function setPortalToken(token: string | null): void {
  if (token) localStorage.setItem(PORTAL_TOKEN_KEY, token);
  else localStorage.removeItem(PORTAL_TOKEN_KEY);
}

export async function portalApiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getPortalToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...options, headers });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body.error ?? "حدث خطأ غير متوقع", res.status);
  }
  return body as T;
}
