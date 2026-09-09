import { ApiError } from "../api/client";

// ZATCA Customer Onboarding & Compliance Center — maps
// server/src/lib/zatca/errors.ts's ZatcaErrorCategory into customer-facing
// Arabic guidance. This is presentation only: it never changes what
// actually happened (the raw backend message is always shown alongside),
// never claims a category the response didn't send, and never invents a
// category — an error with no `category` (any non-ZATCA route, or a ZATCA
// response that genuinely omitted one) falls through to a generic, honest
// "unknown outcome" presentation rather than guessing one of these.

export interface ZatcaErrorPresentation {
  title: string;
  // Whether the customer should simply try again.
  retryGuidance: "retry" | "fix_then_retry" | "no_retry" | "wait_and_retry";
  retryGuidanceText: string;
  // Whether this requires MIDAD support / a company admin to intervene
  // (vs. something the current user can resolve themselves).
  needsAdminOrSupport: boolean;
}

const PRESENTATIONS: Record<string, ZatcaErrorPresentation> = {
  configuration: {
    title: "الإعداد غير مكتمل",
    retryGuidance: "fix_then_retry",
    retryGuidanceText: "أكملي الخطوة الناقصة (موضّحة أدناه) ثم أعيدي المحاولة.",
    needsAdminOrSupport: false,
  },
  authentication: {
    title: "مشكلة في المصادقة مع ZATCA",
    retryGuidance: "no_retry",
    retryGuidanceText: "رفضت ZATCA بيانات الاعتماد أو رمز التحقق (OTP) المُستخدم — تحققي من صحتها قبل إعادة المحاولة.",
    needsAdminOrSupport: true,
  },
  authorization: {
    title: "الشهادة غير مخوّلة لهذا الإجراء",
    retryGuidance: "no_retry",
    retryGuidanceText: "الشهادة الحالية غير مصرّح لها بتنفيذ هذا الإجراء تحديداً — راجعي بيئة الاتصال (محاكاة/إنتاج) ومرحلة الشهادة.",
    needsAdminOrSupport: true,
  },
  validation: {
    title: "رفضت ZATCA البيانات المُرسلة",
    retryGuidance: "fix_then_retry",
    retryGuidanceText: "صحّحي البيانات المذكورة في الرسالة أدناه ثم أعيدي المحاولة — لا فائدة من إعادة الإرسال بدون تعديل.",
    needsAdminOrSupport: false,
  },
  duplicate: {
    title: "تم إرسال هذا الطلب مسبقاً",
    retryGuidance: "no_retry",
    retryGuidanceText: "أبلغت ZATCA أن هذا الطلب أُرسل مسبقاً بنجاح — لا حاجة لإعادة الإرسال.",
    needsAdminOrSupport: false,
  },
  rate_limited: {
    title: "عدد كبير جداً من المحاولات",
    retryGuidance: "wait_and_retry",
    retryGuidanceText: "انتظري بضع دقائق ثم أعيدي المحاولة.",
    needsAdminOrSupport: false,
  },
  network: {
    title: "تعذّر الوصول إلى ZATCA",
    retryGuidance: "wait_and_retry",
    retryGuidanceText: "قد تكون هذه مشكلة اتصال مؤقتة — أعيدي المحاولة بعد قليل. إن استمرت المشكلة، تواصلي مع الدعم.",
    needsAdminOrSupport: false,
  },
  external_service: {
    title: "خدمة ZATCA غير متاحة حالياً",
    retryGuidance: "wait_and_retry",
    retryGuidanceText: "وصلت المنصة إلى ZATCA لكن الرد كان غير متوقع أو الخدمة غير متاحة — أعيدي المحاولة بعد قليل.",
    needsAdminOrSupport: false,
  },
  not_implemented: {
    title: "هذه الميزة غير متاحة بعد",
    retryGuidance: "no_retry",
    retryGuidanceText: "هذا الإجراء غير مُفعّل في هذه النسخة من المنصة — تواصلي مع الدعم لمعرفة الخطوات البديلة.",
    needsAdminOrSupport: true,
  },
  internal: {
    title: "حدث خطأ داخلي في المنصة",
    retryGuidance: "no_retry",
    retryGuidanceText: "هذا خطأ من جهة MIDAD وليس بيانات ZATCA — تواصلي مع الدعم مع ذكر الوقت التقريبي لحدوثه.",
    needsAdminOrSupport: true,
  },
};

const UNKNOWN_PRESENTATION: ZatcaErrorPresentation = {
  title: "تعذّر إتمام الإجراء",
  retryGuidance: "retry",
  retryGuidanceText: "أعيدي المحاولة. إن استمرت المشكلة، تواصلي مع الدعم.",
  needsAdminOrSupport: false,
};

export interface PresentedZatcaError extends ZatcaErrorPresentation {
  message: string;
}

// Never receives or exposes an Authorization header, credential, private
// key, or raw stack trace — err.message on ApiError is always the safe,
// already-sanitized string the backend itself chose to send (see
// errors.ts's own file comment: every ZatcaError message is safe to
// render before it is ever thrown).
export function presentZatcaError(err: unknown, fallbackMessage: string): PresentedZatcaError {
  if (err instanceof ApiError) {
    const presentation = (err.category && PRESENTATIONS[err.category]) || UNKNOWN_PRESENTATION;
    return { ...presentation, message: err.message };
  }
  return { ...UNKNOWN_PRESENTATION, message: fallbackMessage };
}
