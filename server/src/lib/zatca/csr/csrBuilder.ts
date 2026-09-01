// PKCS#10 CSR (Certificate Signing Request) generation for ZATCA CSID
// onboarding — Slice 5 continuation.
//
// LIBRARY CHOICE: node-forge (named in the continuation's own instruction)
// has no ECDSA/EC support at all (see keyPair.ts's file comment for how
// this was verified). Since the CSR must carry an ECDSA public key,
// `@peculiar/x509` is used instead — actively maintained (Peculiar
// Ventures; the library backing many production PKI/ACME tools), built on
// WebCrypto, with first-class EC support and no hand-rolled ASN.1/crypto
// of MIDAD's own. This is a deliberate substitution of the RIGHT
// well-maintained library for the actual requirement, not a decision to
// implement CSR/ASN.1 encoding by hand.
//
// FIELD PROVENANCE — see docs/zatca/SLICE5_OFFICIAL_SPEC_VERIFICATION.md:
//   - Common Name, Organization Name, Organizational Unit Name, Country
//     Name map to the standard, public PKIX/X.500 attribute types
//     (commonName 2.5.4.3, organizationName 2.5.4.10,
//     organizationalUnitName 2.5.4.11, countryName 2.5.4.6) — these OIDs
//     are a public international standard (ITU-T X.520), not a ZATCA
//     invention, so hardcoding them is not guessing ZATCA-specific detail.
//   - Organization Identifier uses OID 2.5.4.97 (X.520
//     "organizationIdentifier"), the standard public PKIX attribute
//     commonly used for VAT/registration numbers in other e-invoicing PKI
//     schemes (e.g. ETSI EN 319 412 qualified certificates). Whether ZATCA
//     itself uses this exact OID is UNVERIFIED (SPEC_TEXT_REQUIRED) — the
//     user-supplied baseline named the field but not an OID.
//   - EGS Serial Number, Invoice Type (TSXY), Location, and Industry are
//     ZATCA-CUSTOM attribute types. Their OIDs were not supplied and are
//     NOT invented here — the caller must supply each one explicitly via
//     `customAttributeOids`, or CSR generation fails loudly naming the
//     missing OID as SPEC_TEXT_REQUIRED, rather than omitting the field or
//     guessing a number.
//
// The private key never appears in this module's return value except as
// the CryptoKeyPair the caller already generated — this module only reads
// the public key and signs with the private key; see domain/csr.ts (task
// #51) for how the private key is handed to ZatcaSecretStore immediately
// afterward, never persisted here.

import "reflect-metadata";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { ZatcaConfigurationError, ZatcaValidationError } from "../errors.js";
import type { EcdsaKeyPairPem } from "./keyPair.js";

// Node's `webcrypto` and lib.dom's `Crypto` type are structurally
// near-identical (both implement the same W3C WebCrypto interface) but
// carry incompatible TypeScript declarations — a well-known friction point
// between @types/node and lib.dom, not a real runtime mismatch (verified
// working end-to-end against the same object during development).
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

// Standard PKIX/X.500 attribute type OIDs — public, not ZATCA-specific.
const OID_COMMON_NAME = "2.5.4.3";
const OID_ORGANIZATION_NAME = "2.5.4.10";
const OID_ORGANIZATIONAL_UNIT_NAME = "2.5.4.11";
const OID_COUNTRY_NAME = "2.5.4.6";
// X.520 organizationIdentifier — public standard OID; ZATCA's own usage
// of it is unverified (see file comment above).
const OID_ORGANIZATION_IDENTIFIER = "2.5.4.97";

export interface ZatcaCsrCustomAttributeOids {
  egsSerialNumber: string;
  invoiceType: string;
  location: string;
  industry: string;
}

export interface ZatcaCsrFields {
  commonName: string;
  egsSerialNumber: string;
  organizationIdentifier: string;
  organizationUnitName: string;
  organizationName: string;
  countryCode: string;
  // TSXY structure per the user-supplied baseline: documented examples
  // "1000" (Standard only), "0100" (Simplified only), "1100"
  // (Standard+Simplified); X and Y remain "0" by default. Not validated
  // beyond "exactly 4 digits" — the exact semantics of every position
  // beyond T and S are SPEC_TEXT_REQUIRED.
  invoiceType: string;
  location: string;
  industry: string;
}

const ORGANIZATION_IDENTIFIER_PATTERN = /^3\d{13}3$/;
const INVOICE_TYPE_PATTERN = /^\d{4}$/;

export function validateZatcaCsrFields(fields: ZatcaCsrFields): void {
  if (!fields.commonName.trim()) throw new ZatcaValidationError("CSR commonName is required");
  if (!ORGANIZATION_IDENTIFIER_PATTERN.test(fields.organizationIdentifier)) {
    throw new ZatcaValidationError(
      "CSR organizationIdentifier must be exactly 15 digits, starting and ending with '3' (VAT/Group VAT Registration Number format)",
    );
  }
  if (!INVOICE_TYPE_PATTERN.test(fields.invoiceType)) {
    throw new ZatcaValidationError("CSR invoiceType must be exactly 4 digits (TSXY structure)");
  }
  if (!/^[A-Z]{2}$/.test(fields.countryCode)) {
    throw new ZatcaValidationError("CSR countryCode must be a 2-letter ISO 3166-1 alpha-2 code");
  }
  if (!fields.egsSerialNumber.trim()) throw new ZatcaValidationError("CSR egsSerialNumber is required");
  if (!fields.organizationUnitName.trim()) throw new ZatcaValidationError("CSR organizationUnitName is required");
  if (!fields.organizationName.trim()) throw new ZatcaValidationError("CSR organizationName is required");
  if (!fields.location.trim()) throw new ZatcaValidationError("CSR location is required");
  if (!fields.industry.trim()) throw new ZatcaValidationError("CSR industry is required");
}

function requireCustomOid(oids: Partial<ZatcaCsrCustomAttributeOids>, key: keyof ZatcaCsrCustomAttributeOids, label: string): string {
  const oid = oids[key];
  if (!oid) {
    throw new ZatcaConfigurationError(
      `No OID configured for the ZATCA-custom CSR attribute "${label}" (customAttributeOids.${key}). This is a ` +
        "ZATCA-specific attribute whose OID is SPEC_TEXT_REQUIRED — it was not supplied in the specification " +
        "content this deployment was built against, and zatca.gov.sa is unreachable to confirm it. Configure it " +
        "explicitly once verified against the real ZATCA CSR generation tool/spec; this is a deliberate refusal " +
        "to invent an OID, not a bug.",
    );
  }
  return oid;
}

export interface BuildZatcaCsrInput {
  fields: ZatcaCsrFields;
  keys: EcdsaKeyPairPem;
  customAttributeOids: Partial<ZatcaCsrCustomAttributeOids>;
}

export interface ZatcaCsrResult {
  csrPem: string;
  csrDerBase64: string;
}

// Builds and signs a real PKCS#10 CSR carrying the caller's ECDSA public
// key and the ZATCA-required subject fields. Never touches the private
// key material beyond using it to sign (via WebCrypto, never exporting or
// logging it here).
export async function buildZatcaCsr(input: BuildZatcaCsrInput): Promise<ZatcaCsrResult> {
  validateZatcaCsrFields(input.fields);

  const name: x509.JsonName = [
    { [OID_COMMON_NAME]: [input.fields.commonName] },
    { [OID_ORGANIZATION_NAME]: [input.fields.organizationName] },
    { [OID_ORGANIZATIONAL_UNIT_NAME]: [input.fields.organizationUnitName] },
    { [OID_COUNTRY_NAME]: [input.fields.countryCode] },
    { [OID_ORGANIZATION_IDENTIFIER]: [input.fields.organizationIdentifier] },
    { [requireCustomOid(input.customAttributeOids, "egsSerialNumber", "EGS Serial Number")]: [input.fields.egsSerialNumber] },
    { [requireCustomOid(input.customAttributeOids, "invoiceType", "Invoice Type (TSXY)")]: [input.fields.invoiceType] },
    { [requireCustomOid(input.customAttributeOids, "location", "Location")]: [input.fields.location] },
    { [requireCustomOid(input.customAttributeOids, "industry", "Industry")]: [input.fields.industry] },
  ];

  const signingAlgorithm = { name: "ECDSA", namedCurve: input.keys.curve, hash: "SHA-256" };
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name,
    keys: input.keys.cryptoKeyPair,
    signingAlgorithm,
  });

  return {
    csrPem: csr.toString("pem"),
    csrDerBase64: csr.toString("base64"),
  };
}
