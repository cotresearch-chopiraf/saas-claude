import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getMailer,
  resetMailerForTests,
  sendMail,
  ConsoleMailProvider,
  ResendMailProvider,
  MailDeliveryError,
} from "../src/lib/mailer.js";

// Slice AA — provider selection/configuration + delivery-failure behavior.
// Mirrors the exact fail-closed testing pattern already established for
// lib/zatca/secretStore/index.ts's production guard (zatcaSecretStoreGuard.test.ts).

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  MAIL_PROVIDER: process.env.MAIL_PROVIDER,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  MAIL_FROM_ADDRESS: process.env.MAIL_FROM_ADDRESS,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  resetMailerForTests();
  vi.restoreAllMocks();
});

describe("getMailer() provider selection", () => {
  it("returns a ConsoleMailProvider when NODE_ENV is unset (matches this environment's actual default)", () => {
    delete process.env.NODE_ENV;
    delete process.env.MAIL_PROVIDER;
    expect(getMailer()).toBeInstanceOf(ConsoleMailProvider);
  });

  it("returns a ConsoleMailProvider for a non-production NODE_ENV with no explicit provider", () => {
    process.env.NODE_ENV = "development";
    delete process.env.MAIL_PROVIDER;
    expect(getMailer()).toBeInstanceOf(ConsoleMailProvider);
  });

  it("throws MailDeliveryError when NODE_ENV=production with no MAIL_PROVIDER set (never silently falls back to console)", () => {
    process.env.NODE_ENV = "production";
    delete process.env.MAIL_PROVIDER;
    expect(() => getMailer()).toThrow(MailDeliveryError);
  });

  it("throws MailDeliveryError when MAIL_PROVIDER=resend but RESEND_API_KEY/MAIL_FROM_ADDRESS are missing", () => {
    process.env.MAIL_PROVIDER = "resend";
    delete process.env.RESEND_API_KEY;
    delete process.env.MAIL_FROM_ADDRESS;
    expect(() => getMailer()).toThrow(MailDeliveryError);
  });

  it("returns a ResendMailProvider when MAIL_PROVIDER=resend with both required variables set", () => {
    process.env.MAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "test-key";
    process.env.MAIL_FROM_ADDRESS = "noreply@example.com";
    expect(getMailer()).toBeInstanceOf(ResendMailProvider);
  });

  it("MAIL_PROVIDER=console works even in production (explicit opt-in, not a silent fallback)", () => {
    process.env.NODE_ENV = "production";
    process.env.MAIL_PROVIDER = "console";
    expect(getMailer()).toBeInstanceOf(ConsoleMailProvider);
  });

  it("caches the provider across calls until resetMailerForTests()", () => {
    delete process.env.NODE_ENV;
    const first = getMailer();
    const second = getMailer();
    expect(first).toBe(second);
  });
});

describe("ResendMailProvider.send()", () => {
  it("posts to the Resend API with the API key in the Authorization header, never in the body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const provider = new ResendMailProvider({ apiKey: "secret-key-value", fromAddress: "noreply@example.com" });

    await provider.send({ to: "user@example.com", subject: "Test", text: "Hello" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key-value");
    expect(String(init?.body)).not.toContain("secret-key-value");
  });

  it("throws MailDeliveryError on a non-ok response, without leaking the provider's response body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("provider internal detail", { status: 422 }));
    const provider = new ResendMailProvider({ apiKey: "k", fromAddress: "noreply@example.com" });

    await expect(provider.send({ to: "user@example.com", subject: "s", text: "t" })).rejects.toThrow(
      MailDeliveryError,
    );
    try {
      await provider.send({ to: "user@example.com", subject: "s", text: "t" });
    } catch (err) {
      expect((err as Error).message).not.toContain("provider internal detail");
    }
  });

  it("throws MailDeliveryError on a network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = new ResendMailProvider({ apiKey: "k", fromAddress: "noreply@example.com" });
    await expect(provider.send({ to: "user@example.com", subject: "s", text: "t" })).rejects.toThrow(
      MailDeliveryError,
    );
  });
});

describe("sendMail() (backward-compatible call-site shape)", () => {
  it("delegates to the configured provider successfully in the default (console) configuration", async () => {
    delete process.env.NODE_ENV;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(sendMail("user@example.com", "Subject", "Body")).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalled();
  });

  it("rejects (does not swallow) when production has no provider configured", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.MAIL_PROVIDER;
    await expect(sendMail("user@example.com", "Subject", "Body")).rejects.toThrow(MailDeliveryError);
  });
});
