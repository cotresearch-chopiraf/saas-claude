import { logger } from "./logger.js";

// Slice AA — provider-independent email abstraction. Business code (auth.ts,
// company.ts) never talks to a specific vendor's SDK/API directly — it only
// calls sendMail() below. Swapping or adding a provider (SendGrid, SES, ...)
// means adding one new class implementing MailProvider here, never touching
// a call site.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailProvider {
  send(message: MailMessage): Promise<void>;
}

export class MailDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MailDeliveryError";
  }
}

// --- Development/test provider ---
// The original MVP behavior, preserved exactly, now behind the interface
// instead of being the only implementation that exists. Never used in
// production — see getMailer() below.
export class ConsoleMailProvider implements MailProvider {
  async send(message: MailMessage): Promise<void> {
    console.log(`\n--- [DEV MAIL] to=${message.to} subject="${message.subject}" ---\n${message.text}\n---\n`);
  }
}

// --- Production provider: Resend ---
// Chosen because it was already the provider named in this codebase's own
// prior "needs a Resend/SendGrid API key" comment, and its API is a single
// authenticated HTTP POST — implemented via plain fetch rather than adding
// an SDK dependency for one endpoint. Never logs the API key; only ever
// reads it from configuration, never hardcodes it.
export interface ResendMailProviderConfig {
  apiKey: string;
  fromAddress: string;
}

// AC-07 — Resend is one authenticated POST with no expectation of a long
// server-side operation (unlike ZATCA's clearance/reporting calls, which
// document their own timeout separately); 10s is generous headroom above a
// normal response while still bounding the request instead of letting a
// hung TCP connection block the caller (and, for the callers that await
// mail delivery inline, the HTTP response) indefinitely.
const RESEND_TIMEOUT_MS = 10_000;

export class ResendMailProvider implements MailProvider {
  constructor(private readonly config: ResendMailProviderConfig) {}

  async send(message: MailMessage): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.config.fromAddress,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // Same fail-closed classification pattern as fatooraClient.ts: only
      // treat this as a timeout if OUR controller is the one that aborted
      // it (a caller-supplied signal or an unrelated abort would look the
      // same to `fetch` otherwise). Never include the API key or the
      // request body (may carry a reset/invite link) in a thrown error
      // message — only the network failure reason.
      if (controller.signal.aborted) {
        throw new MailDeliveryError(`انتهت مهلة الاتصال بمزوّد البريد الإلكتروني بعد ${RESEND_TIMEOUT_MS}ms`, {
          cause: err,
        });
      }
      throw new MailDeliveryError("تعذّر الاتصال بمزوّد البريد الإلكتروني", { cause: err });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      // The provider's own error body may echo request content back —
      // never forward it verbatim into logs/errors, only the HTTP status.
      throw new MailDeliveryError(`فشل إرسال البريد الإلكتروني (رمز الحالة ${res.status})`);
    }
  }
}

// --- Provider selection ---
// Mirrors the exact fail-closed discipline already established for
// lib/zatca/secretStore/index.ts's production guard: a production
// deployment must never silently degrade to a behavior that only looks
// like it worked. Selected once per process (not per call) so a missing
// production config is caught at first use, not buried inside a specific
// request's error handling.
let cachedProvider: MailProvider | null = null;

export function resetMailerForTests(): void {
  cachedProvider = null;
}

export function getMailer(): MailProvider {
  if (cachedProvider) return cachedProvider;

  const explicitProvider = process.env.MAIL_PROVIDER;

  if (explicitProvider === "resend") {
    const apiKey = process.env.RESEND_API_KEY;
    const fromAddress = process.env.MAIL_FROM_ADDRESS;
    if (!apiKey || !fromAddress) {
      throw new MailDeliveryError(
        "MAIL_PROVIDER=resend يتطلب تعيين RESEND_API_KEY و MAIL_FROM_ADDRESS — لن يتم إرسال أي بريد إلكتروني",
      );
    }
    cachedProvider = new ResendMailProvider({ apiKey, fromAddress });
    return cachedProvider;
  }

  if (explicitProvider === "console") {
    cachedProvider = new ConsoleMailProvider();
    return cachedProvider;
  }

  // No explicit MAIL_PROVIDER set. Development/test may fall back to the
  // console provider — but production must never silently do the same
  // (that would be exactly the "email sent" false-success state this
  // slice's own rules forbid). Fail closed instead of guessing.
  if (process.env.NODE_ENV === "production") {
    throw new MailDeliveryError(
      "لم يتم تكوين مزوّد بريد إلكتروني للإنتاج — يجب تعيين MAIL_PROVIDER=resend مع بيانات الاعتماد المطلوبة",
    );
  }

  cachedProvider = new ConsoleMailProvider();
  return cachedProvider;
}

// Preserves the existing call-site shape (three positional strings) so
// auth.ts/company.ts needed no redesign — only this function's own body
// changed, from "always console.log" to "delegate to the configured
// provider, fail closed in production." Callers decide for themselves
// whether a delivery failure should change their own HTTP response (see
// auth.ts's request-password-reset, which deliberately must not — see its
// own comment) — this function only ever reports success/failure, it
// never decides how a caller should react to either.
export async function sendMail(to: string, subject: string, body: string): Promise<void> {
  try {
    await getMailer().send({ to, subject, text: body });
  } catch (err) {
    if (err instanceof MailDeliveryError) {
      // Never log `to`'s message body (may carry a reset/invite token) or
      // any credential — only that delivery failed and why, generically.
      logger.error("mail_delivery_failed", { message: err.message });
      throw err;
    }
    throw err;
  }
}
