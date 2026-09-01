// Real XAdES-BES enveloped signer for ZATCA invoice XML — Slice 5
// continuation.
//
// STRUCTURE PROVENANCE — see docs/zatca/SLICE5_OFFICIAL_SPEC_VERIFICATION.md:
//   - SignedProperties (SigningTime, SigningCertificate/Cert/CertDigest/
//     DigestMethod+DigestValue, IssuerSerial/X509IssuerName+
//     X509SerialNumber) and the two SignedInfo References
//     (Id="invoiceSignedData" for the invoice hash;
//     URI="#xades-SignedProperties" for the SignedProperties digest) are
//     USER-SUPPLIED as the specification baseline for this continuation —
//     not independently verified against zatca.gov.sa (unreachable).
//   - The "invoiceSignedData" Reference's DigestValue is set DIRECTLY to
//     the same canonical invoice hash canonicalHash.ts already computes
//     (computeCanonicalInvoiceHash), rather than dereferenced via a
//     URI + Transform chain — the user-supplied content says only "the
//     invoice reference with the invoice hash," not a URI or transform
//     chain, and inventing one would be exactly the kind of unverified
//     structural detail the task instruction forbids guessing. XMLDSig's
//     Reference/@URI is optional by spec (RFC 3275 §4.3.3.1: "the
//     absence of URI... indicates that the referent is identified by
//     other means"), so omitting it here is spec-conformant, not a
//     workaround — it is SPEC_TEXT_REQUIRED which URI/Transform chain
//     ZATCA itself expects, if any.
//   - Everything else needed to make this a complete, well-formed
//     XAdES-BES signature (the enclosing <Signature>/<SignedInfo>/
//     <SignatureValue>/<KeyInfo>/<Object><QualifyingProperties> skeleton)
//     follows the PUBLIC, non-ZATCA-specific XMLDSig
//     (http://www.w3.org/2000/09/xmldsig#) and XAdES
//     (http://uri.etsi.org/01903/v1.3.2#) standard namespace URIs — fixed,
//     published identifiers, not guesses. Exact attribute ordering, ID
//     naming, and XAdES version beyond what the user supplied are this
//     module's own minimal standards-conformant choices, never presented
//     as ZATCA-verified.
//   - The signature is embedded inside `ext:UBLExtensions`, the standard
//     UBL digital-signature extension convention — and the reason
//     canonicalHash.ts strips ext:UBLExtensions before hashing in the
//     first place.
//
// CANONICALIZATION: the same xml-crypto C14N canonicalHash.ts already uses
// (http://www.w3.org/TR/2001/REC-xml-c14n-20010315), applied to
// SignedProperties and to SignedInfo before hashing/signing each —
// standard XMLDSig practice.
//
// SIGNATURE ALGORITHM: ECDSA-SHA256 (XMLDSig's public, standard
// http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256 URI), matching the
// ECDSA key pair this deployment generates (csr/keyPair.ts). WebCrypto's
// ECDSA sign() output is IEEE P1363 (raw r||s) format, which is exactly
// what XMLDSig's SignatureValue expects for ECDSA — no re-encoding step.

import "reflect-metadata";
import { createHash, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { C14nCanonicalization } from "xml-crypto";
import { DOMParser } from "@xmldom/xmldom";
import { el, renderXmlNode, type XmlElement } from "../xmlSafety.js";
import { computeCanonicalInvoiceHash } from "../canonicalHash.js";
import { importEcdsaPrivateKeyFromPem } from "../csr/keyPair.js";
import { ZatcaConfigurationError, ZatcaInternalError } from "../errors.js";
import type { ZatcaSignInput, ZatcaSignResult, ZatcaSigner } from "./types.js";

// See csrBuilder.ts's identical line for why this cast is needed (a
// TypeScript declaration mismatch between @types/node's webcrypto and
// lib.dom's Crypto, not a real runtime incompatibility). Safe to call
// whether or not csrBuilder.ts has already set it in this process.
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const XMLDSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const XADES_NS = "http://uri.etsi.org/01903/v1.3.2#";
const C14N_ALGORITHM = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const ECDSA_SHA256_ALGORITHM = "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256";
const SHA256_ALGORITHM = "http://www.w3.org/2000/09/xmldsig#sha256";
const XADES_SIGNED_PROPERTIES_TYPE = "http://uri.etsi.org/01903#SignedProperties";

function sha256Base64(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("base64");
}

// Canonicalizes a standalone XML fragment: wraps it in a throwaway root
// carrying the namespace declaration the fragment's own elements rely on
// (a bare fragment string has no namespace context of its own), parses,
// then canonicalizes only the fragment's own root element — never the
// synthetic wrapper.
function c14nFragment(fragmentXml: string, wrapperNamespaceAttrs: string): string {
  const wrapped = `<root ${wrapperNamespaceAttrs}>${fragmentXml}</root>`;
  const doc = new DOMParser().parseFromString(wrapped, "text/xml");
  const wrapperEl = (doc as unknown as { documentElement: { firstChild: unknown } }).documentElement;
  return new C14nCanonicalization().process(wrapperEl.firstChild as unknown as Node, {});
}

interface ParsedCertificate {
  derBase64: string;
  issuerDistinguishedName: string;
  serialNumberDecimal: string;
  digestBase64: string;
}

// Accepts either a PEM-wrapped certificate or a raw base64 DER string
// (binarySecurityToken's exact on-the-wire shape is unconfirmed — see
// provider/types.ts — so both are handled rather than assuming one).
//
// LIBRARY CHOICE: node-forge cannot parse this certificate at all when its
// public key is EC — verified directly (attempting it throws "Cannot read
// public key. OID is not RSA."), the same RSA-only limitation documented
// in keyPair.ts/csrBuilder.ts. @peculiar/x509's X509Certificate parses any
// algorithm's certificate generically (it only needs the DER structure,
// not the public key's own algorithm), so it is used here too, for the
// same reason it's used for CSR generation.
function parseCertificate(binarySecurityToken: string): ParsedCertificate {
  let cert: x509.X509Certificate;
  try {
    cert = new x509.X509Certificate(binarySecurityToken);
  } catch (err) {
    throw new ZatcaConfigurationError(
      `Failed to parse the stored certificate (binarySecurityToken) as X.509: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const serialNumberDecimal = BigInt(`0x${cert.serialNumber || "0"}`).toString(10);
  const derBuffer = Buffer.from(cert.rawData);

  return {
    derBase64: derBuffer.toString("base64"),
    issuerDistinguishedName: cert.issuer,
    serialNumberDecimal,
    digestBase64: sha256Base64(derBuffer),
  };
}

function buildSignedProperties(signingTimeIso: string, cert: ParsedCertificate): XmlElement {
  return el("xades:SignedProperties", { Id: "xades-SignedProperties" }, [
    el("xades:SignedSignatureProperties", [
      el("xades:SigningTime", [signingTimeIso]),
      el("xades:SigningCertificate", [
        el("xades:Cert", [
          el("xades:CertDigest", [
            el("ds:DigestMethod", { Algorithm: SHA256_ALGORITHM }, []),
            el("ds:DigestValue", [cert.digestBase64]),
          ]),
          el("xades:IssuerSerial", [
            el("ds:X509IssuerName", [cert.issuerDistinguishedName]),
            el("ds:X509SerialNumber", [cert.serialNumberDecimal]),
          ]),
        ]),
      ]),
    ]),
  ]);
}

function buildSignedInfo(invoiceHashBase64: string, signedPropertiesDigestBase64: string): XmlElement {
  return el("ds:SignedInfo", [
    el("ds:CanonicalizationMethod", { Algorithm: C14N_ALGORITHM }, []),
    el("ds:SignatureMethod", { Algorithm: ECDSA_SHA256_ALGORITHM }, []),
    // URI intentionally omitted — see file-level comment on
    // "invoiceSignedData" provenance.
    el("ds:Reference", { Id: "invoiceSignedData" }, [
      el("ds:DigestMethod", { Algorithm: SHA256_ALGORITHM }, []),
      el("ds:DigestValue", [invoiceHashBase64]),
    ]),
    el("ds:Reference", { Type: XADES_SIGNED_PROPERTIES_TYPE, URI: "#xades-SignedProperties" }, [
      el("ds:DigestMethod", { Algorithm: SHA256_ALGORITHM }, []),
      el("ds:DigestValue", [signedPropertiesDigestBase64]),
    ]),
  ]);
}

async function signBytes(privateKeyPem: string, curve: string, data: string): Promise<string> {
  const key = await importEcdsaPrivateKeyFromPem(privateKeyPem, curve);
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(data, "utf8"));
  return Buffer.from(signature).toString("base64");
}

// Real, deterministic-given-the-same-inputs-and-timestamp, testable XAdES
// signer. Fails with a specific ZatcaConfigurationError — never a
// fabricated signature — whenever the credential lacks what real signing
// requires (a private key MIDAD generated locally; see provider/types.ts's
// ResolvedZatcaCredential comment for why that's usually absent today,
// before CSID onboarding — task #51 — is wired up).
export class XadesZatcaSigner implements ZatcaSigner {
  async sign(input: ZatcaSignInput): Promise<ZatcaSignResult> {
    const { credential } = input;
    if (!credential.privateKeyPem || !credential.curve) {
      throw new ZatcaConfigurationError(
        "No private key is available for this EGS unit's credential yet. Real XAdES signing requires the ECDSA " +
          "private key MIDAD generated locally during CSR/CSID onboarding — this credential was connected " +
          "without one (see provider/types.ts's ResolvedZatcaCredential). Complete CSID onboarding for this EGS " +
          "unit before submitting.",
      );
    }
    if (!credential.binarySecurityToken) {
      throw new ZatcaConfigurationError("No certificate (binarySecurityToken) is available for this EGS unit's credential.");
    }

    const cert = parseCertificate(credential.binarySecurityToken);
    const invoiceHashBase64 = computeCanonicalInvoiceHash(input.canonicalXml);
    // Millisecond precision dropped to match XMLDSig/XAdES's conventional
    // xsd:dateTime-without-fractional-seconds SigningTime format.
    const signingTimeIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    const signedProperties = buildSignedProperties(signingTimeIso, cert);
    const signedPropertiesDigestBase64 = sha256Base64(
      c14nFragment(renderXmlNode(signedProperties), `xmlns:xades="${XADES_NS}" xmlns:ds="${XMLDSIG_NS}"`),
    );

    const signedInfo = buildSignedInfo(invoiceHashBase64, signedPropertiesDigestBase64);
    const signedInfoCanonical = c14nFragment(renderXmlNode(signedInfo), `xmlns:ds="${XMLDSIG_NS}"`);

    const signatureValueBase64 = await signBytes(credential.privateKeyPem, credential.curve, signedInfoCanonical);

    const signatureXml = el("ds:Signature", { "xmlns:ds": XMLDSIG_NS, "xmlns:xades": XADES_NS, Id: "zatca-signature" }, [
      signedInfo,
      el("ds:SignatureValue", [signatureValueBase64]),
      el("ds:KeyInfo", [el("ds:X509Data", [el("ds:X509Certificate", [cert.derBase64])])]),
      el("ds:Object", [el("xades:QualifyingProperties", { Target: "#zatca-signature" }, [signedProperties])]),
    ]);

    const signedXml = embedSignatureInUblExtensions(input.canonicalXml, renderXmlNode(signatureXml));

    return { signedXml, signatureValueBase64 };
  }
}

// Inserts the signature XML into the invoice's ext:UBLExtensions block,
// creating that block if it does not already exist (true for every
// document xmlBuilder.ts currently produces — the block never exists
// before a real signer runs). Placed as the invoice's first child, ahead
// of cbc:ProfileID, matching the standard UBL convention that
// UBLExtensions precedes all other invoice content.
function embedSignatureInUblExtensions(xml: string, signatureXml: string): string {
  const extensionBlock =
    `<ext:UBLExtensions>` +
    `<ext:UBLExtension><ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>` +
    `<ext:ExtensionContent>${signatureXml}</ext:ExtensionContent></ext:UBLExtension>` +
    `</ext:UBLExtensions>`;

  const insertionPoint = xml.indexOf("<cbc:ProfileID>");
  if (insertionPoint === -1) {
    throw new ZatcaInternalError("Cannot embed signature: invoice XML does not contain the expected <cbc:ProfileID> anchor element");
  }
  return xml.slice(0, insertionPoint) + extensionBlock + xml.slice(insertionPoint);
}
