import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
import { useTranslation } from "../i18n/I18nProvider";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";

export function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await apiFetch("/auth/request-password-reset", { method: "POST", body: JSON.stringify({ email }) });
    setSent(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="fixed top-4 end-4 z-20">
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-xl font-bold text-primary">{t("auth.forgotPassword.title")}</h1>

        {sent ? (
          <p className="text-sm text-stone-600">{t("auth.forgotPassword.sentMessage")}</p>
        ) : (
          <form onSubmit={onSubmit}>
            <label className="mb-6 block text-sm">
              {t("auth.forgotPassword.email")}
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
              />
            </label>
            <button type="submit" className="w-full rounded-md bg-primary py-2 font-medium text-white">
              {t("auth.forgotPassword.submit")}
            </button>
          </form>
        )}

        <p className="mt-4 text-center text-sm text-stone-500">
          <Link to="/login" className="text-primary underline">{t("auth.forgotPassword.backToLogin")}</Link>
        </p>
      </div>
    </div>
  );
}
