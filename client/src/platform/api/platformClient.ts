import { ApiError } from "../../api/client";
import { translateStatic } from "../../i18n/I18nProvider";

// MIDAD — Platform Admin Console (client for D1/D2) — deliberately its own token key, its own
// storage functions, and its own fetch wrapper: ../../api/client.ts's
// TOKEN_KEY/apiFetch are the tenant session's only storage, and a
// platform session must never collide with or be readable through them.
// This is the client-side mirror of the server-side rule established in
// D1/D2 — platform and tenant identity never share a mechanism.
const PLATFORM_TOKEN_KEY = "midad_platform_token";

export function getPlatformToken(): string | null {
  return localStorage.getItem(PLATFORM_TOKEN_KEY);
}

export function setPlatformToken(token: string | null): void {
  if (token) localStorage.setItem(PLATFORM_TOKEN_KEY, token);
  else localStorage.removeItem(PLATFORM_TOKEN_KEY);
}

export async function platformApiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getPlatformToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...options, headers });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body.error ?? translateStatic("common.errorGeneric"), res.status);
  }
  return body as T;
}
