import { FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";

export function ResetPassword() {
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
      setError(err instanceof ApiError ? err.message : "تعذّر تحديث كلمة المرور");
    }
  }

  return (
    <div dir="rtl" className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-xl font-bold text-primary">تعيين كلمة مرور جديدة</h1>

        {done ? (
          <p className="text-sm text-emerald-600">تم التحديث بنجاح، جاري تحويلك لتسجيل الدخول...</p>
        ) : !token ? (
          <p className="text-sm text-red-600">
            الرابط غير صالح.{" "}
            <Link to="/forgot-password" className="underline">اطلبي رابطاً جديداً</Link>
          </p>
        ) : (
          <form onSubmit={onSubmit}>
            {error && <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <label className="mb-6 block text-sm">
              كلمة المرور الجديدة
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
              حفظ كلمة المرور
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
