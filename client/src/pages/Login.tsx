import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { useTranslation } from "../i18n/I18nProvider";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  // Phase 3.2 P0 remediation (LOGIN-001) — this is the real customer-facing
  // login screen, not a demo environment: it must never pre-fill or expose
  // a usable set of credentials. Fields start empty; every real user types
  // their own email/password, exactly like any other production login form.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      setError(err instanceof ApiError ? err.message : t("auth.login.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="fixed top-4 end-4 z-20">
        <LanguageSwitcher />
      </div>
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-xl font-bold text-primary">{t("auth.login.title")}</h1>

        {error && <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <label className="mb-3 block text-sm">
          {t("auth.login.email")}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </label>
        <label className="mb-2 block text-sm">
          {t("auth.login.password")}
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </label>
        <p className="mb-6 text-end text-xs">
          <Link to="/forgot-password" className="text-stone-400 underline hover:text-primary">{t("auth.login.forgotPassword")}</Link>
        </p>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-primary py-2 font-medium text-white disabled:opacity-60"
        >
          {submitting ? t("auth.login.submitting") : t("auth.login.submit")}
        </button>

        <p className="mt-4 text-center text-sm text-stone-500">
          {t("auth.login.noAccount")} <Link to="/register" className="text-primary underline">{t("auth.login.createCompany")}</Link>
        </p>
      </form>
    </div>
  );
}
