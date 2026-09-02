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
