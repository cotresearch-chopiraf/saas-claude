import { FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import { useTranslation } from "../i18n/I18nProvider";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";

export function ResetPassword() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword }) });
      setDone(true);
      setTimeout(() => navigate("/login"), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.resetPassword.genericError"));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="fixed top-4 end-4 z-20">
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-xl font-bold text-primary">{t("auth.resetPassword.title")}</h1>

        {done ? (
          <p className="text-sm text-emerald-600">{t("auth.resetPassword.success")}</p>
        ) : !token ? (
          <p className="text-sm text-red-600">
            {t("auth.resetPassword.invalidLink")}{" "}
            <Link to="/forgot-password" className="underline">{t("auth.resetPassword.requestNewLink")}</Link>
          </p>
        ) : (
          <form onSubmit={onSubmit}>
            {error && <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <label className="mb-6 block text-sm">
              {t("auth.resetPassword.newPassword")}
              <input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
              />
            </label>
            <button type="submit" className="w-full rounded-md bg-primary py-2 font-medium text-white">
              {t("auth.resetPassword.submit")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
