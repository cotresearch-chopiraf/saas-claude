import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { useTranslation } from "../i18n/I18nProvider";

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [companyName, setCompanyName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register(companyName, name, email, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.register.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-xl font-bold text-primary">{t("auth.register.title")}</h1>

        {error && <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <label className="mb-3 block text-sm">
          {t("auth.register.companyName")}
          <input
            required
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </label>
        <label className="mb-3 block text-sm">
          {t("auth.register.yourName")}
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </label>
        <label className="mb-3 block text-sm">
          {t("auth.register.email")}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </label>
        <label className="mb-6 block text-sm">
          {t("auth.register.password")}
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </label>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-primary py-2 font-medium text-white disabled:opacity-60"
        >
          {submitting ? t("auth.register.submitting") : t("auth.register.submit")}
        </button>

        <p className="mt-4 text-center text-sm text-stone-500">
          {t("auth.register.haveAccount")} <Link to="/login" className="text-primary underline">{t("auth.register.signIn")}</Link>
        </p>
      </form>
    </div>
  );
}
