import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Card, Button, ErrorState } from "../../ui";
import { ApiError } from "../../api/client";
import { usePlatformAuth } from "../auth/PlatformAuthContext";

export function PlatformLogin() {
  const { operator, login } = usePlatformAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (operator) return <Navigate to="/platform/organizations" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/platform/organizations", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تسجيل الدخول");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-100 px-4" dir="rtl">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-6 text-center text-lg font-bold text-stone-800">دخول مشغّلي المنصة</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          {error && <ErrorState message={error} />}
          <input
            type="email"
            required
            placeholder="البريد الإلكتروني"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <input
            type="password"
            required
            placeholder="كلمة المرور"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "جارٍ الدخول..." : "دخول"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
