import { FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, setToken, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { User } from "../api/types";

export function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<{ token: string; user: User }>("/auth/accept-invite", {
        method: "POST",
        body: JSON.stringify({ token, name, password }),
      });
      setToken(res.token);
      // Synchronize authenticated user/role state through the same
      // canonical /auth/me path login()/register() already use — never a
      // second, ad hoc source of truth — before navigating into the
      // protected app, so ProtectedRoute never sees a token with no user
      // state behind it yet.
      await refreshUser();
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر قبول الدعوة");
    }
  }

  return (
    <div dir="rtl" className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-xl font-bold text-primary">انضمام إلى الفريق</h1>

        {!token ? (
          <p className="text-sm text-red-600">
            رابط الدعوة غير صالح. <Link to="/login" className="underline">العودة لتسجيل الدخول</Link>
          </p>
        ) : (
          <form onSubmit={onSubmit}>
            {error && <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <label className="mb-3 block text-sm">
              اسمك
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
              />
            </label>
            <label className="mb-6 block text-sm">
              كلمة المرور
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
              />
            </label>
            <button type="submit" className="w-full rounded-md bg-primary py-2 font-medium text-white">
              انضمام
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
