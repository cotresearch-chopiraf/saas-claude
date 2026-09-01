import type { ResolvedZatcaCredential } from "../provider/types.js";

// The signing boundary (Slice 4). ZATCA Phase 2 requires a cryptographic
// signature (XAdES-BES enveloped signature over the canonicalized UBL XML,
// per cross-corroborated secondary-source descriptions of the ZATCA
// Electronic Invoice XML Implementation Standard) before Clearance/
// Reporting will accept a document — an unsigned document is not a valid
// submission, so nothing in this codebase submits one.
//
// This interface exists so that boundary is explicit and swappable: today
// the only implementation (notImplementedSigner.ts) always fails, honestly,
// because this environment cannot verify the primary ZATCA cryptographic
// specification (WebFetch cannot reach zatca.gov.sa here) and has no real
// tenant certificate/private key to sign with. A future implementation
// satisfying this exact interface — built once the specification and real
// credentials are available — is a drop-in; nothing outside signer/ needs
// to change.

export interface ZatcaSignInput {
  canonicalXml: string;
  credential: ResolvedZatcaCredential;
}

export interface ZatcaSignResult {
  signedXml: string;
  // Base64 of the raw signature value — kept separate from signedXml so a
  // caller that only needs to prove a signature exists never has to
  // re-parse XML to find it.
  signatureValueBase64: string;
}

export interface ZatcaSigner {
  sign(input: ZatcaSignInput): Promise<ZatcaSignResult>;
}
