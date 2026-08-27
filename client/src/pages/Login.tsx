import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("demo@contractor-os.test");
  const [password, setPassword] = useState("demo1234");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تسجيل الدخول");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div dir="rtl" className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-bold text-primary">تسجيل الدخول</h1>
        <p className="mb-6 text-sm text-stone-500">
          حساب تجريبي معبّأ مسبقاً — اضغط "دخول" مباشرة لتجربة النظام.
        </p>

        {error && <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <label className="mb-3 block text-sm">
          البريد الإلكتروني
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </label>
        <label className="mb-2 block text-sm">
          كلمة المرور
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </label>
        <p className="mb-6 text-left text-xs">
          <Link to="/forgot-password" className="text-stone-400 underline hover:text-primary">نسيت كلمة المرور؟</Link>
        </p>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-primary py-2 font-medium text-white disabled:opacity-60"
        >
          {submitting ? "جارٍ الدخول..." : "دخول"}
        </button>

        <p className="mt-4 text-center text-sm text-stone-500">
          لا تملك حساباً؟ <Link to="/register" className="text-primary underline">أنشئ شركتك</Link>
        </p>
      </form>
    </div>
  );
}
