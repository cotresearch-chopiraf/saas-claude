import { describe, it, expect, afterEach } from "vitest";
import { generateEcdsaKeyPair, requireConfiguredEcdsaCurve, importEcdsaPrivateKeyFromPem } from "../src/lib/zatca/csr/keyPair.js";
import { buildZatcaCsr, validateZatcaCsrFields, type ZatcaCsrFields } from "../src/lib/zatca/csr/csrBuilder.js";
import { ZatcaConfigurationError, ZatcaValidationError } from "../src/lib/zatca/errors.js";

// Slice 5 continuation — CSR/key-pair generation. See csrBuilder.ts and
// keyPair.ts file comments for full provenance (which fields/OIDs are
// USER-SUPPLIED vs. public PKIX standards vs. SPEC_TEXT_REQUIRED). These
// tests verify MIDAD's own code does what it claims (real key generation,
// real signed CSR, honest refusal to guess unverified detail) — never that
// the output matches what a real ZATCA endpoint will accept.

const originalCurve = process.env.ZATCA_CSR_ECDSA_CURVE;
afterEach(() => {
  if (originalCurve === undefined) delete process.env.ZATCA_CSR_ECDSA_CURVE;
  else process.env.ZATCA_CSR_ECDSA_CURVE = originalCurve;
});

describe("requireConfiguredEcdsaCurve", () => {
  it("throws ZatcaConfigurationError (naming SPEC_TEXT_REQUIRED) when unset", () => {
    delete process.env.ZATCA_CSR_ECDSA_CURVE;
    expect(() => requireConfiguredEcdsaCurve()).toThrow(ZatcaConfigurationError);
    try {
      requireConfiguredEcdsaCurve();
    } catch (err) {
      expect(err instanceof Error && err.message).toContain("SPEC_TEXT_REQUIRED");
    }
  });

  it("throws for an unsupported curve name", () => {
    process.env.ZATCA_CSR_ECDSA_CURVE = "not-a-real-curve";
    expect(() => requireConfiguredEcdsaCurve()).toThrow(ZatcaConfigurationError);
  });

  it("returns the curve when it is a supported WebCrypto ECDSA curve", () => {
    process.env.ZATCA_CSR_ECDSA_CURVE = "P-256";
    expect(requireConfiguredEcdsaCurve()).toBe("P-256");
  });
});

describe("generateEcdsaKeyPair", () => {
  it("refuses to generate without a configured curve", async () => {
    delete process.env.ZATCA_CSR_ECDSA_CURVE;
    await expect(generateEcdsaKeyPair()).rejects.toThrow(ZatcaConfigurationError);
  });

  it("generates a real PEM-encoded EC key pair once a curve is configured", async () => {
    process.env.ZATCA_CSR_ECDSA_CURVE = "P-256";
    const keys = await generateEcdsaKeyPair();
    expect(keys.privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(keys.publicKeyPem).toContain("-----BEGIN PUBLIC KEY-----");
    expect(keys.curve).toBe("P-256");
    expect(keys.cryptoKeyPair.privateKey.type).toBe("private");
    expect(keys.cryptoKeyPair.publicKey.type).toBe("public");
  });

  it("generates a DIFFERENT key pair on every call (real randomness, not a fixture)", async () => {
    process.env.ZATCA_CSR_ECDSA_CURVE = "P-256";
    const a = await generateEcdsaKeyPair();
    const b = await generateEcdsaKeyPair();
    expect(a.privateKeyPem).not.toBe(b.privateKeyPem);
  });

  it("importEcdsaPrivateKeyFromPem round-trips a generated private key back into a usable CryptoKey", async () => {
    process.env.ZATCA_CSR_ECDSA_CURVE = "P-256";
    const keys = await generateEcdsaKeyPair();
    const reimported = await importEcdsaPrivateKeyFromPem(keys.privateKeyPem, "P-256");
    expect(reimported.type).toBe("private");
    expect(reimported.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
  });
});

const validFields: ZatcaCsrFields = {
  commonName: "EGS-UNIT-1",
  egsSerialNumber: "1-ACME-SW|2-1.0.0|3-SN12345",
  organizationIdentifier: "399999999900003",
  organizationUnitName: "Riyadh Branch",
  organizationName: "Test Company LLC",
  countryCode: "SA",
  invoiceType: "1100",
  location: "Riyadh, Saudi Arabia",
  industry: "Construction",
};

const customOids = {
  egsSerialNumber: "2.16.840.1.113883.3.9999.1",
  invoiceType: "2.16.840.1.113883.3.9999.2",
  location: "2.16.840.1.113883.3.9999.3",
  industry: "2.16.840.1.113883.3.9999.4",
};

describe("validateZatcaCsrFields", () => {
  it("accepts a well-formed field set", () => {
    expect(() => validateZatcaCsrFields(validFields)).not.toThrow();
  });

  it.each([
    ["not 15 digits", "39999999990003"],
    ["does not start with 3", "199999999900003"],
    ["does not end with 3", "399999999900001"],
    ["contains letters", "39999999990000A"],
  ])("rejects organizationIdentifier that %s", (_label, value) => {
    expect(() => validateZatcaCsrFields({ ...validFields, organizationIdentifier: value })).toThrow(ZatcaValidationError);
  });

  it.each([["1000"], ["0100"], ["1100"], ["0000"]])("accepts a 4-digit invoiceType (%s)", (value) => {
    expect(() => validateZatcaCsrFields({ ...validFields, invoiceType: value })).not.toThrow();
  });

  it("rejects an invoiceType that is not exactly 4 digits", () => {
    expect(() => validateZatcaCsrFields({ ...validFields, invoiceType: "11000" })).toThrow(ZatcaValidationError);
    expect(() => validateZatcaCsrFields({ ...validFields, invoiceType: "1" })).toThrow(ZatcaValidationError);
  });

  it("rejects a countryCode that is not 2 uppercase letters", () => {
    expect(() => validateZatcaCsrFields({ ...validFields, countryCode: "sa" })).toThrow(ZatcaValidationError);
    expect(() => validateZatcaCsrFields({ ...validFields, countryCode: "SAU" })).toThrow(ZatcaValidationError);
  });

  it.each(["commonName", "egsSerialNumber", "organizationUnitName", "organizationName", "location", "industry"] as const)(
    "rejects an empty %s",
    (field) => {
      expect(() => validateZatcaCsrFields({ ...validFields, [field]: "  " })).toThrow(ZatcaValidationError);
    },
  );
});

describe("buildZatcaCsr", () => {
  it("refuses to build without every ZATCA-custom OID configured, naming SPEC_TEXT_REQUIRED", async () => {
    process.env.ZATCA_CSR_ECDSA_CURVE = "P-256";
    const keys = await generateEcdsaKeyPair();
    await expect(buildZatcaCsr({ fields: validFields, keys, customAttributeOids: {} })).rejects.toThrow(ZatcaConfigurationError);
    try {
      await buildZatcaCsr({ fields: validFields, keys, customAttributeOids: {} });
    } catch (err) {
      expect(err instanceof Error && err.message).toContain("SPEC_TEXT_REQUIRED");
    }
  });

  it("refuses with an invalid field set even if OIDs are configured (validates before signing)", async () => {
    process.env.ZATCA_CSR_ECDSA_CURVE = "P-256";
    const keys = await generateEcdsaKeyPair();
    await expect(
      buildZatcaCsr({ fields: { ...validFields, organizationIdentifier: "bad" }, keys, customAttributeOids: customOids }),
    ).rejects.toThrow(ZatcaValidationError);
  });

  it("builds a real, well-formed, signed PKCS#10 CSR once fields and OIDs are complete", async () => {
    process.env.ZATCA_CSR_ECDSA_CURVE = "P-256";
    const keys = await generateEcdsaKeyPair();
    const result = await buildZatcaCsr({ fields: validFields, keys, customAttributeOids: customOids });
    expect(result.csrPem).toContain("-----BEGIN CERTIFICATE REQUEST-----");
    expect(result.csrPem).toContain("-----END CERTIFICATE REQUEST-----");
    expect(result.csrDerBase64.length).toBeGreaterThan(0);
    // The DER should re-parse cleanly as a certificate request via a fresh
    // PKCS#10 parse, and it should carry the commonName we asked for.
    const { Pkcs10CertificateRequest } = await import("@peculiar/x509");
    const parsed = new Pkcs10CertificateRequest(result.csrDerBase64);
    expect(parsed.subject).toContain(validFields.commonName);
  });

  it("never includes the private key material anywhere in the CSR PEM output", async () => {
    process.env.ZATCA_CSR_ECDSA_CURVE = "P-256";
    const keys = await generateEcdsaKeyPair();
    const result = await buildZatcaCsr({ fields: validFields, keys, customAttributeOids: customOids });
    // A CSR is public-key-only by construction, but assert it directly:
    // the private key PEM body must never appear as a substring anywhere.
    const privateKeyBody = keys.privateKeyPem.replace(/-----[^-]+-----/g, "").trim();
    expect(result.csrPem).not.toContain(privateKeyBody);
  });
});
