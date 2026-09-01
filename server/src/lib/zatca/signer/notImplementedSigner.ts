import { ZatcaNotImplementedError } from "../errors.js";
import type { ZatcaSignInput, ZatcaSignResult, ZatcaSigner } from "./types.js";

// The only ZatcaSigner implementation that exists in this environment.
// Always fails, honestly and immediately — never returns a "signature"
// that merely looks well-formed. Two independent verification gaps both
// have to close before a real signer can be built here: (1) the primary
// ZATCA XAdES/cryptographic-stamp specification is unverifiable (WebFetch
// cannot reach zatca.gov.sa), and (2) no real tenant certificate/private
// key exists in this environment to sign with even if the spec were known.
// See ../signer/types.ts's file comment.
export class NotImplementedSigner implements ZatcaSigner {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sign(_input: ZatcaSignInput): Promise<ZatcaSignResult> {
    throw new ZatcaNotImplementedError(
      "XAdES signing is not implemented in this environment: the official ZATCA cryptographic-stamp " +
        "specification could not be verified from a primary source, and no real credential material exists " +
        "to sign with. This is a real, honest limitation — no signature is fabricated.",
    );
  }
}
