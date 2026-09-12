import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Card, Button, ErrorState } from "../../ui";
import { ApiError } from "../../api/client";
import { useClientPortalAuth } from "../auth/ClientPortalAuthContext";
import { useTranslation } from "../../i18n/I18nProvider";

export function PortalLogin() {
  const { t, direction } = useTranslation();
  const { portalUser, login } = useClientPortalAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (portalUser) return <Navigate to="/portal" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/portal", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.login.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-100 px-4" dir={direction}>
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 text-center">
          <p className="text-sm font-semibold text-stone-500">MIDAD</p>
          <h1 className="text-lg font-bold text-stone-800">{t("portalLayout.tagline")}</h1>
        </div>
        <form onSubmit={onSubmit} className="space-y-3">
          {error && <ErrorState message={error} />}
          <input
            type="email"
            required
            placeholder={t("auth.login.email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <input
            type="password"
            required
            placeholder={t("auth.login.password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? t("auth.login.submitting") : t("auth.login.submit")}
          </Button>
        </form>
      </Card>
    </div>
  );
}
