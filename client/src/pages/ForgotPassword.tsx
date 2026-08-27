import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await apiFetch("/auth/request-password-reset", { method: "POST", body: JSON.stringify({ email }) });
    setSent(true);
  }

  return (
    <div dir="rtl" className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-xl font-bold text-primary">استعادة كلمة المرور</h1>

        {sent ? (
          <p className="text-sm text-stone-600">
            إن كان بريدك الإلكتروني مسجّلاً لدينا، فستصلك رسالة تحتوي على رابط إعادة التعيين.
          </p>
        ) : (
          <form onSubmit={onSubmit}>
            <label className="mb-6 block text-sm">
              البريد الإلكتروني
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
              />
            </label>
            <button type="submit" className="w-full rounded-md bg-primary py-2 font-medium text-white">
              إرسال رابط إعادة التعيين
            </button>
          </form>
        )}

        <p className="mt-4 text-center text-sm text-stone-500">
          <Link to="/login" className="text-primary underline">العودة لتسجيل الدخول</Link>
        </p>
      </div>
    </div>
  );
}
