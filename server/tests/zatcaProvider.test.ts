import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { FatooraProvider } from "../src/lib/zatca/provider/fatooraProvider.js";
import {
  ZatcaAuthenticationError,
  ZatcaConfigurationError,
  ZatcaExternalServiceError,
  ZatcaNetworkError,
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

  it("downgrades a 200 response with a rejected body status to status: rejected", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clearanceStatus: "REJECTED", validationResults: { status: "ERROR" } }));
    });
    cleanup = server.close;
    setEnv(server.url);

    const result = await new FatooraProvider("simulation").clearInvoice(credential, document);
    expect(result.status).toBe("rejected");
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
