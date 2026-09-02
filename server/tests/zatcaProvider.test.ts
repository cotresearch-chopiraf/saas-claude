import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { FatooraProvider } from "../src/lib/zatca/provider/fatooraProvider.js";
import {
  ZatcaAuthenticationError,
  ZatcaAuthorizationError,
  ZatcaConfigurationError,
  ZatcaDuplicateError,
  ZatcaExternalServiceError,
  ZatcaNetworkError,
  ZatcaRateLimitedError,
  ZatcaValidationError,
} from "../src/lib/zatca/errors.js";

// MIDAD ZATCA Slice 3 — FATOORA client/provider tests, against a real local
// HTTP server (never the real ZATCA network — this environment cannot
// reach zatca.gov.sa at all, and even if it could, automated tests must
// never call real production ZATCA). No database needed: this whole file
// exercises lib/zatca/provider/ only.

const ENV_KEYS = [
  "ZATCA_FATOORA_SIMULATION_BASE_URL",
  "ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH",
  "ZATCA_FATOORA_SIMULATION_COMPLIANCE_CSID_PATH",
  "ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH",
  "ZATCA_FATOORA_SIMULATION_REPORTING_PATH",
  "ZATCA_FATOORA_TIMEOUT_MS",
];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setEnv(baseUrl: string, timeoutMs?: number) {
  process.env.ZATCA_FATOORA_SIMULATION_BASE_URL = baseUrl;
  process.env.ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH = "compliance/invoices";
  process.env.ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH = "invoices/clearance/single";
  process.env.ZATCA_FATOORA_SIMULATION_REPORTING_PATH = "invoices/reporting/single";
  if (timeoutMs) process.env.ZATCA_FATOORA_TIMEOUT_MS = String(timeoutMs);
}

// Compliance CSID (POST /compliance) is a distinct, separately-configured
// path from ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH above (that variable
// is already used for the Compliance Invoice endpoint /compliance/invoices
// — see fatooraClient.ts's FatooraEndpointConfig comment), so this helper
// sets both the base config and this one extra variable, kept separate
// from setEnv() so the existing Reporting/Clearance/Compliance-Invoice
// tests above are unaffected.
function setComplianceCsidEnv(baseUrl: string, timeoutMs?: number) {
  setEnv(baseUrl, timeoutMs);
  process.env.ZATCA_FATOORA_SIMULATION_COMPLIANCE_CSID_PATH = "compliance";
}

function startMockServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

const credential = { binarySecurityToken: "test-token", secret: "test-secret" };
const document = { invoiceXmlBase64: "PGE+PC9hPg==", invoiceHashBase64: "abc123==", uuid: "11111111-1111-1111-1111-111111111111" };

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  clearEnv();
});

describe("FatooraProvider configuration", () => {
  it("throws ZatcaConfigurationError when the environment endpoint is not configured", async () => {
    clearEnv();
    const provider = new FatooraProvider("simulation");
    await expect(provider.checkConnection(credential)).rejects.toBeInstanceOf(ZatcaConfigurationError);
  });
});

describe("FatooraProvider document submission", () => {
  it("normalizes a successful clearance response", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clearanceStatus: "CLEARED", validationResults: { status: "PASS" } }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").clearInvoice(credential, document);
    expect(result.status).toBe("cleared");
    expect(result.rawStatus).toBe("CLEARED");
    expect(result.correlationId).toBeTruthy();
  });

  it("downgrades a 200 response with a rejected body status to status: rejected (verified enum: NOT_CLEARED)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clearanceStatus: "NOT_CLEARED", clearedInvoice: null, validationResults: { status: "ERROR" } }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").clearInvoice(credential, document);
    expect(result.status).toBe("rejected");
    expect(result.clearedInvoiceXmlBase64).toBeUndefined();
  });

  it("throws ZatcaAuthenticationError on a 401 response", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaAuthenticationError);
  });

  it("throws ZatcaValidationError on a 400 response", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad request" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaValidationError);
  });

  it("throws ZatcaExternalServiceError on a 500 response", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(500);
      res.end("internal error");
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaExternalServiceError);
  });

  it("throws ZatcaExternalServiceError on a malformed (non-JSON) response", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not json</html>");
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaExternalServiceError);
  });

  it("throws ZatcaNetworkError on a timeout", async () => {
    const server = await startMockServer(() => {
      // Never respond.
    });
    cleanup = server.close;
    setEnv(server.url, 200);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaNetworkError);
  }, 10000);

  it("throws ZatcaNetworkError on connection refused (no server listening)", async () => {
    setEnv("http://127.0.0.1:1"); // port 1 -- nothing listens there
    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaNetworkError);
  });

  it("throws ZatcaNetworkError on DNS resolution failure", async () => {
    setEnv("http://this-host-does-not-resolve.invalid");
    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaNetworkError);
  }, 15000);

  it("throws ZatcaValidationError on a 404 response", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "status 404" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaValidationError);
  });

  // Slice 5 — 403 (authorization), 409 (duplicate), and 429 (rate_limited)
  // are now distinct categories from generic validation/authentication —
  // standard HTTP semantics only, see errors.ts.
  it("throws ZatcaAuthorizationError on a 403 response, distinct from 401 authentication", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaAuthorizationError);
  });

  it("throws ZatcaDuplicateError on a 409 response", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "conflict" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaDuplicateError);
  });

  it("throws ZatcaRateLimitedError (retryable) on a 429 response", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "too many requests" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const err = await new FatooraProvider("simulation").clearInvoice(credential, document).catch((e) => e);
    expect(err).toBeInstanceOf(ZatcaRateLimitedError);
    expect(err.retryable).toBe(true);
  });

  it.each([500, 502, 503])("throws ZatcaExternalServiceError on a %i response", async (status) => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `status ${status}` }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaExternalServiceError);
  });

  it("NEVER converts an unrecognized 2xx body into success (no clearanceStatus/reportingStatus/status/validationResults at all)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ somethingElse: "unexpected shape" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaExternalServiceError);
  });

  it("NEVER converts an empty 2xx body into success", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaExternalServiceError);
  });
});

describe("FatooraProvider.reportInvoice (verified Reporting contract)", () => {
  it("normalizes a REPORTED response to status: reported, and sends Clearance-Status: 0", async () => {
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    const server = await startMockServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reportingStatus: "REPORTED", validationResults: { status: "PASS" } }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").reportInvoice(credential, document);
    expect(result.status).toBe("reported");
    expect(result.rawStatus).toBe("REPORTED");
    expect(receivedHeaders?.["clearance-status"]).toBe("0");
    expect(receivedHeaders?.["accept-version"]).toBe("V2");
    expect(receivedHeaders?.["accept-language"]).toBe("en");
  });

  it("still reports success when validationResults.status is WARNING (verified 202 example)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reportingStatus: "REPORTED", validationResults: { status: "WARNING", warningMessages: ["x"] } }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").reportInvoice(credential, document);
    expect(result.status).toBe("reported");
  });

  it("normalizes a NOT_REPORTED response to status: rejected", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reportingStatus: "NOT_REPORTED", validationResults: { status: "ERROR" } }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").reportInvoice(credential, document);
    expect(result.status).toBe("rejected");
    expect(result.rawStatus).toBe("NOT_REPORTED");
  });

  it("throws ZatcaDuplicateError on a 409 (verified: already reported earlier)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Invoice was already Reported successfully earlier" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").reportInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaDuplicateError);
  });

  it("throws ZatcaExternalServiceError when reportingStatus is missing/unrecognized", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ somethingElse: true }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").reportInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaExternalServiceError);
  });
});

describe("FatooraProvider.clearInvoice (verified Clearance contract)", () => {
  it("normalizes a CLEARED response to status: cleared, extracts clearedInvoiceXmlBase64, and sends Clearance-Status: 1", async () => {
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    const clearedInvoiceXml = "PGNsZWFyZWQ+PC9jbGVhcmVkPg==";
    const server = await startMockServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clearanceStatus: "CLEARED", clearedInvoice: clearedInvoiceXml, validationResults: { status: "PASS" } }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").clearInvoice(credential, document);
    expect(result.status).toBe("cleared");
    expect(result.clearedInvoiceXmlBase64).toBe(clearedInvoiceXml);
    expect(receivedHeaders?.["clearance-status"]).toBe("1");
    expect(receivedHeaders?.["accept-version"]).toBe("V2");
  });

  it("never populates clearedInvoiceXmlBase64 for a NOT_CLEARED response even if the field is present", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clearanceStatus: "NOT_CLEARED", clearedInvoice: "should-be-ignored", validationResults: { status: "ERROR" } }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").clearInvoice(credential, document);
    expect(result.status).toBe("rejected");
    expect(result.clearedInvoiceXmlBase64).toBeUndefined();
  });

  it("throws ZatcaDuplicateError on a 208 (verified: invoice hash previously submitted)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(208, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Invoice Hash Previously Submitted" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaDuplicateError);
  });

  it("throws ZatcaConfigurationError on a 303 (verified: clearance deactivated, use Reporting instead)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(303, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Clearance is deactiviated. Please use the /invoices/reporting/single endpoint instead." }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaConfigurationError);
  });

  it("throws ZatcaExternalServiceError when clearanceStatus is missing/unrecognized", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ somethingElse: true }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").clearInvoice(credential, document)).rejects.toBeInstanceOf(ZatcaExternalServiceError);
  });
});

describe("FatooraProvider.checkConnection", () => {
  it("returns connected:false (never throws) when ZATCA rejects the credential", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").checkConnection(credential);
    expect(result.connected).toBe(false);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });

  it("returns connected:true when the endpoint responds without rejecting the credential", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").checkConnection(credential);
    expect(result.connected).toBe(true);
  });

  it("propagates ZatcaNetworkError on a real network failure (no server listening)", async () => {
    setEnv("http://127.0.0.1:1"); // port 1 — nothing listens there
    await expect(new FatooraProvider("simulation").checkConnection(credential)).rejects.toBeInstanceOf(ZatcaNetworkError);
  });
});

// Slice A (ZATCA Network Integration continuation) — requestComplianceCsid,
// against the VERIFIED "Compliance CSID API" Swagger export
// (compliance_csid.pdf, "e-Invoicing Sandbox Release (2.1.0)") the user
// obtained from their own ZATCA Developer Portal account. This endpoint
// (POST /compliance) has no ResolvedZatcaCredential — it produces one —
// so these tests call the provider method directly with a raw CSR + OTP,
// never with the shared `credential` fixture used above.
describe("FatooraProvider.requestComplianceCsid (verified Compliance CSID contract)", () => {
  const csrBase64 = "TFMwdExTMUNSVWRKVGlCRFJWSlVTVVpKUTBGVVJTMHRMUzA9"; // arbitrary placeholder bytes, not a real CSR

  it("throws ZatcaConfigurationError when the Compliance CSID path is not configured", async () => {
    setEnv("http://127.0.0.1:1"); // base config present, but no COMPLIANCE_CSID_PATH
    await expect(new FatooraProvider("simulation").requestComplianceCsid(csrBase64, "123456")).rejects.toBeInstanceOf(
      ZatcaConfigurationError,
    );
  });

  it("sends no Authorization header, and sends OTP + Accept-Version: V2 + the verified {csr} body", async () => {
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    let receivedBody = "";
    const server = await startMockServer((req, res) => {
      receivedHeaders = req.headers;
      req.on("data", (chunk) => (receivedBody += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            requestID: 1234567890123,
            dispositionMessage: "ISSUED",
            binarySecurityToken: "cert-bytes-base64",
            secret: "shared-secret-value",
          }),
        );
      });
    });
    cleanup = server.close;
    setComplianceCsidEnv(server.url);

    const result = await new FatooraProvider("simulation").requestComplianceCsid(csrBase64, "123456");

    expect(receivedHeaders?.authorization).toBeUndefined();
    expect(receivedHeaders?.otp).toBe("123456");
    expect(receivedHeaders?.["accept-version"]).toBe("V2");
    expect(JSON.parse(receivedBody)).toEqual({ csr: csrBase64 });

    expect(result).toEqual({
      requestId: "1234567890123",
      dispositionMessage: "ISSUED",
      binarySecurityToken: "cert-bytes-base64",
      secret: "shared-secret-value",
    });
  });

  it("throws ZatcaValidationError with the ZATCA error detail on Missing-OTP (400)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ code: "Missing-OTP", message: "OTP is required field" }] }));
    });
    cleanup = server.close;
    setComplianceCsidEnv(server.url);

    const err = await new FatooraProvider("simulation").requestComplianceCsid(csrBase64, "").catch((e) => e);
    expect(err).toBeInstanceOf(ZatcaValidationError);
    expect(err.message).toContain("Missing-OTP");
    expect(err.message).toContain("OTP is required field");
  });

  it("throws ZatcaValidationError with the ZATCA error detail on Invalid-OTP (400)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ code: "Invalid-OTP", message: "The provided OTP is invalid" }] }));
    });
    cleanup = server.close;
    setComplianceCsidEnv(server.url);

    const err = await new FatooraProvider("simulation").requestComplianceCsid(csrBase64, "000000").catch((e) => e);
    expect(err).toBeInstanceOf(ZatcaValidationError);
    expect(err.message).toContain("Invalid-OTP");
  });

  it("throws ZatcaValidationError with the ZATCA error detail on Missing-CSR (400)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ code: "Missing-CSR", message: "CSR is required field" }] }));
    });
    cleanup = server.close;
    setComplianceCsidEnv(server.url);

    const err = await new FatooraProvider("simulation").requestComplianceCsid("", "123456").catch((e) => e);
    expect(err).toBeInstanceOf(ZatcaValidationError);
    expect(err.message).toContain("Missing-CSR");
  });

  it("throws ZatcaValidationError with the ZATCA error detail on Invalid-CSR (400)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ code: "Invalid-CSR", message: "The provided CSR is invalid" }] }));
    });
    cleanup = server.close;
    setComplianceCsidEnv(server.url);

    const err = await new FatooraProvider("simulation").requestComplianceCsid("not-a-real-csr", "123456").catch((e) => e);
    expect(err).toBeInstanceOf(ZatcaValidationError);
    expect(err.message).toContain("Invalid-CSR");
  });

  it("throws ZatcaValidationError on a 406 (unsupported/missing Accept-Version)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(406, { "Content-Type": "text/plain;charset=UTF-8" });
      res.end("This Version is not supported or not provided in the header.");
    });
    cleanup = server.close;
    setComplianceCsidEnv(server.url);

    await expect(new FatooraProvider("simulation").requestComplianceCsid(csrBase64, "123456")).rejects.toBeInstanceOf(
      ZatcaValidationError,
    );
  });

  it("throws ZatcaExternalServiceError with the ZATCA error detail on a 500", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "Invalid-Request", message: "System failed to process your request" }));
    });
    cleanup = server.close;
    setComplianceCsidEnv(server.url);

    const err = await new FatooraProvider("simulation").requestComplianceCsid(csrBase64, "123456").catch((e) => e);
    expect(err).toBeInstanceOf(ZatcaExternalServiceError);
    expect(err.message).toContain("Invalid-Request");
    expect(err.message).toContain("System failed to process your request");
  });

  it("throws ZatcaExternalServiceError when a 200 response is missing the expected fields", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ somethingElse: true }));
    });
    cleanup = server.close;
    setComplianceCsidEnv(server.url);

    await expect(new FatooraProvider("simulation").requestComplianceCsid(csrBase64, "123456")).rejects.toBeInstanceOf(
      ZatcaExternalServiceError,
    );
  });

  it("throws ZatcaNetworkError on a real network failure (no server listening)", async () => {
    setComplianceCsidEnv("http://127.0.0.1:1"); // port 1 — nothing listens there
    await expect(new FatooraProvider("simulation").requestComplianceCsid(csrBase64, "123456")).rejects.toBeInstanceOf(
      ZatcaNetworkError,
    );
  });
});

// Slice B (ZATCA Network Integration continuation) — submitComplianceDocument
// / normalizeComplianceInvoiceResponse, against the VERIFIED "Compliance
// Invoice API" Swagger export (compliance_invoice.pdf, "e-Invoicing Sandbox
// Release (2.1.0)"). This endpoint documents TWO genuinely distinct
// response shapes, both occurring under either HTTP 200 or HTTP 400 —
// these tests exercise both, via submitComplianceDocument end-to-end (a
// real mock server, not the normalizer function in isolation) so the
// HTTP-400-carries-a-real-body wiring (fatooraRequestComplianceInvoice) is
// actually verified, not just the parsing logic.
describe("FatooraProvider.submitComplianceDocument (verified Compliance Invoice contract)", () => {
  it("Shape 1: normalizes a 200 REPORTED response to status: compliance_pending, preserving clearanceStatus/qrSellertStatus/qrBuyertStatus", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          validationResults: { status: "PASS", infoMessages: [], warningMessages: [], errorMessages: [] },
          reportingStatus: "REPORTED",
          clearanceStatus: null,
          qrSellertStatus: null,
          qrBuyertStatus: null,
        }),
      );
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").submitComplianceDocument(credential, document);
    expect(result.status).toBe("compliance_pending");
    expect(result.rawStatus).toBe("REPORTED");
    expect(result.clearanceStatus).toBeNull();
    expect(result.qrSellertStatus).toBeNull();
    expect(result.qrBuyertStatus).toBeNull();
  });

  it("Shape 1: preserves a non-null clearanceStatus/qrSellertStatus/qrBuyertStatus when ZATCA returns one", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          validationResults: { status: "PASS" },
          reportingStatus: "REPORTED",
          clearanceStatus: "CLEARED",
          qrSellertStatus: "PASS",
          qrBuyertStatus: "PASS",
        }),
      );
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").submitComplianceDocument(credential, document);
    expect(result.clearanceStatus).toBe("CLEARED");
    expect(result.qrSellertStatus).toBe("PASS");
    expect(result.qrBuyertStatus).toBe("PASS");
  });

  it("Shape 1: a validationResults.status of ERROR alongside reportingStatus NOT_REPORTED normalizes to status: rejected", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          validationResults: {
            status: "ERROR",
            errorMessages: [{ type: "ERROR", code: "BR-KSA-37", category: "KSA", message: "The seller address building number must contain 4 digits.", status: "ERROR" }],
          },
          reportingStatus: "NOT_REPORTED",
          clearanceStatus: null,
          qrSellertStatus: null,
          qrBuyertStatus: null,
        }),
      );
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").submitComplianceDocument(credential, document);
    expect(result.status).toBe("rejected");
    expect(result.rawStatus).toBe("NOT_REPORTED");
  });

  it("Shape 2 (InvoiceResultModel): a 400 QR-code error response normalizes to status: rejected, preserving category/code/message", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          invoiceHash: "some-hash",
          status: "Not Reported",
          warnings: null,
          errors: [
            { category: "QR-Code-Errors", code: "Seller-Name", message: "seller name does not match with qr code seller name" },
            { code: "QR-Hashed-XML", message: "Invalid The XML hash. The XML hash of the invoice does not match with QR Code xml hash" },
          ],
        }),
      );
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").submitComplianceDocument(credential, document);
    expect(result.status).toBe("rejected");
    expect(result.rawStatus).toBe("Not Reported");
    const warnings = result.warnings as { warnings: unknown; errors: Array<{ category?: string; code: string; message: string }> };
    expect(warnings.errors).toHaveLength(2);
    expect(warnings.errors[0]).toEqual({ category: "QR-Code-Errors", code: "Seller-Name", message: "seller name does not match with qr code seller name" });
    expect(warnings.errors[1].code).toBe("QR-Hashed-XML");
  });

  it("Shape 2 (InvoiceResultModel): a 400 signature-error response with multiple errors preserves every entry", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          invoiceHash: "some-hash",
          status: "Not Reported",
          warnings: null,
          errors: [
            { category: "Signature-Errors", code: "X-509-Issuer-Name", message: "Wrong X509IssuerName" },
            { category: "Signature-Errors", code: "Certificate", message: "Wrong Invoice Certificate" },
            { category: "Signature-Errors", code: "Signature-Value", message: "Wrong Signature Value" },
          ],
        }),
      );
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").submitComplianceDocument(credential, document);
    expect(result.status).toBe("rejected");
    const warnings = result.warnings as { errors: unknown[] };
    expect(warnings.errors).toHaveLength(3);
  });

  it("Shape 2: 'Accepted with Warnings' is a real success (status: compliance_pending), never treated as rejection", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          invoiceHash: "some-hash",
          status: "Accepted with Warnings",
          warnings: [{ category: "KSA", code: "BR-KSA-warn", message: "a non-blocking warning" }],
          errors: null,
        }),
      );
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").submitComplianceDocument(credential, document);
    expect(result.status).toBe("compliance_pending");
    expect(result.rawStatus).toBe("Accepted with Warnings");
    const warnings = result.warnings as { warnings: unknown[] };
    expect(warnings.warnings).toHaveLength(1);
  });

  it("Shape 2: a 'Reported' status normalizes to status: compliance_pending", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ invoiceHash: "some-hash", status: "Reported", warnings: null, errors: null }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").submitComplianceDocument(credential, document);
    expect(result.status).toBe("compliance_pending");
  });

  it("throws ZatcaExternalServiceError on a response matching neither documented shape", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ somethingElse: true }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").submitComplianceDocument(credential, document)).rejects.toBeInstanceOf(
      ZatcaExternalServiceError,
    );
  });

  it("throws ZatcaExternalServiceError on a 400 matching neither documented shape (never fabricates a rejection detail)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ unexpected: "shape" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").submitComplianceDocument(credential, document)).rejects.toBeInstanceOf(
      ZatcaExternalServiceError,
    );
  });

  it("throws ZatcaAuthenticationError on a 401 response", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ timestamp: 1654514661409, status: 401, error: "Unauthorized", message: "" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").submitComplianceDocument(credential, document)).rejects.toBeInstanceOf(
      ZatcaAuthenticationError,
    );
  });

  it("throws ZatcaExternalServiceError on a 500 response", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "Invalid-Request", message: "System failed to process your request" }));
    });
    cleanup = server.close;
    setEnv(server.url);

    await expect(new FatooraProvider("simulation").submitComplianceDocument(credential, document)).rejects.toBeInstanceOf(
      ZatcaExternalServiceError,
    );
  });

  it("never populates clearedInvoiceXmlBase64 (that field is Clearance-only)", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reportingStatus: "REPORTED", validationResults: { status: "PASS" } }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").submitComplianceDocument(credential, document);
    expect(result.clearedInvoiceXmlBase64).toBeUndefined();
  });
});

// Regression guard: Reporting/Clearance must be byte-for-byte unaffected by
// Slice B (they never call fatooraRequestComplianceInvoice or
// normalizeComplianceInvoiceResponse) — re-asserts the core success shape
// for each, so a future refactor accidentally routing them through the
// Compliance Invoice path would fail loudly here in addition to the
// existing dedicated describe blocks above.
describe("Slice B regression guard: Reporting/Clearance normalization unchanged", () => {
  it("reportInvoice still returns status: reported for a REPORTED response, with no clearanceStatus/qrSellertStatus/qrBuyertStatus fields", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reportingStatus: "REPORTED", validationResults: { status: "PASS" } }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").reportInvoice(credential, document);
    expect(result.status).toBe("reported");
    expect(result.clearanceStatus).toBeUndefined();
    expect(result.qrSellertStatus).toBeUndefined();
    expect(result.qrBuyertStatus).toBeUndefined();
  });

  it("clearInvoice still returns status: cleared for a CLEARED response", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clearanceStatus: "CLEARED", clearedInvoice: "base64-xml", validationResults: { status: "PASS" } }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").clearInvoice(credential, document);
    expect(result.status).toBe("cleared");
    expect(result.clearedInvoiceXmlBase64).toBe("base64-xml");
  });
});
