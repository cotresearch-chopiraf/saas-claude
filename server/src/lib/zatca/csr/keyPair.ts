// ECDSA key-pair generation for ZATCA CSR/CSID onboarding — Slice 5
// continuation.
//
// LIBRARY CHOICE: the continuation's own instruction named `node-forge`
// for CSR/key generation, but node-forge has NO ECDSA/EC support at all —
// verified directly by inspecting its source (`grep`-ing every file under
// node_modules/node-forge/lib for "ecdsa"/"EC PRIVATE"/named-curve OIDs
// found nothing; node-forge only implements RSA key generation). Since the
// user-supplied spec baseline explicitly calls for an ECDSA key pair, this
// module uses Node's own built-in WebCrypto (`node:crypto`'s `webcrypto`),
// which has native, audited ECDSA support and needs no third-party crypto
// primitive implementation at all — the strongest form of "do not
// implement cryptography manually," stronger than reaching for a
// third-party library. node-forge is still used elsewhere (csrBuilder.ts's
// CSR uses @peculiar/x509 instead, for the same EC-support reason — see
// that file's own comment).
//
// CURVE CHOICE: SPEC_TEXT_REQUIRED. The user-supplied baseline says only
// "ECDSA... generate per official security requirements" — it does not
// name a curve, and zatca.gov.sa is unreachable to check. This module
// refuses to silently default to a guessed curve: the curve MUST be
// supplied explicitly (via ZATCA_CSR_ECDSA_CURVE), and the function throws
// a clear configuration error naming the gap if it is unset, rather than
// ever picking one on its own.
//
// PRIVATE KEY SAFETY: this function returns the private key in memory to
// its caller — callers MUST hand it directly to ZatcaSecretStore (never a
// database column, never a log line, never an API response). See
// domain/csr.ts (task #51) for the only code path allowed to call this.

import { webcrypto } from "node:crypto";
import { ZatcaConfigurationError, ZatcaInternalError } from "../errors.js";

export interface EcdsaKeyPairPem {
  privateKeyPem: string;
  publicKeyPem: string;
  curve: string;
  // The raw WebCrypto key pair generated alongside the PEM export — kept
  // so an immediate caller (e.g. csrBuilder.ts, signing the CSR in the
  // same request) doesn't need to re-import the private key PEM right
  // back into a CryptoKey. Callers that only need to PERSIST the key pair
  // (via ZatcaSecretStore) should persist privateKeyPem/publicKeyPem, not
  // this — CryptoKey objects aren't serializable and don't outlive the
  // process.
  cryptoKeyPair: CryptoKeyPair;
}

// WebCrypto's supported named curves as of Node's current implementation.
// Restricting to this allowlist means an operator's typo in the env var
// fails loudly with a clear message instead of an opaque WebCrypto error.
const SUPPORTED_CURVES = new Set(["P-256", "P-384", "P-521"]);

export function requireConfiguredEcdsaCurve(): string {
  const curve = process.env.ZATCA_CSR_ECDSA_CURVE;
  if (!curve) {
    throw new ZatcaConfigurationError(
      "ZATCA_CSR_ECDSA_CURVE is not set. The ECDSA curve ZATCA requires for CSR key pairs is SPEC_TEXT_REQUIRED " +
        "(the specification content this deployment was built against named ECDSA generally but not a specific " +
        "curve, and zatca.gov.sa is unreachable from this environment to confirm one) — set this explicitly once " +
        "verified against the real ZATCA Security Features Implementation Standard. This is a deliberate refusal " +
        "to guess, not a bug.",
    );
  }
  if (!SUPPORTED_CURVES.has(curve)) {
    throw new ZatcaConfigurationError(
      `ZATCA_CSR_ECDSA_CURVE="${curve}" is not one of the curves this runtime's WebCrypto implementation supports ` +
        `(${Array.from(SUPPORTED_CURVES).join(", ")}).`,
    );
  }
  return curve;
}

function pemEncode(label: string, der: ArrayBuffer): string {
  const base64 = Buffer.from(der).toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// Generates a fresh, extractable ECDSA key pair on the curve required by
// ZATCA_CSR_ECDSA_CURVE. `extractable: true` is required so the private
// key can be exported to PKCS#8 for storage in ZatcaSecretStore — the
// store itself (not this function) is what's responsible for keeping it
// out of plaintext DB columns/logs long-term.
export async function generateEcdsaKeyPair(): Promise<EcdsaKeyPairPem> {
  const curve = requireConfiguredEcdsaCurve();
  const keyPair = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: curve },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const [privateDer, publicDer] = await Promise.all([
    webcrypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    webcrypto.subtle.exportKey("spki", keyPair.publicKey),
  ]);

  return {
    privateKeyPem: pemEncode("PRIVATE KEY", privateDer),
    publicKeyPem: pemEncode("PUBLIC KEY", publicDer),
    curve,
    cryptoKeyPair: keyPair,
  };
}

// Re-imports a PEM-encoded private key back into a CryptoKey for signing
// (e.g. the XAdES signer, task #48) — the inverse of generateEcdsaKeyPair's
// export step. Never logs or echoes the PEM it receives.
export async function importEcdsaPrivateKeyFromPem(privateKeyPem: string, curve: string): Promise<CryptoKey> {
  const body = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  if (!body) {
    throw new ZatcaInternalError("importEcdsaPrivateKeyFromPem received an empty or malformed PEM body");
  }
  const der = Buffer.from(body, "base64");
  return webcrypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: curve }, true, ["sign"]);
}
