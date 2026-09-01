import { describe, it, expect } from "vitest";
import { NotImplementedSigner } from "../src/lib/zatca/signer/notImplementedSigner.js";
import { XadesZatcaSigner } from "../src/lib/zatca/signer/xadesZatcaSigner.js";
import { getZatcaSigner } from "../src/lib/zatca/signer/index.js";
import { ZatcaNotImplementedError } from "../src/lib/zatca/errors.js";

// MIDAD ZATCA Slice 4 — the signing boundary. NotImplementedSigner always
// fails, honestly, regardless of input — see its own file comment for why
// (no verifiable primary XAdES specification, no real credential material
// at the time it was written). The "negative test" categories the Slice 4
// spec asks for (invalid certificate / invalid private key / mismatched
// cert+key / expired certificate / missing credential / malformed XML)
// all collapse into the SAME universal behavior for this signer, because
// it never inspects its input at all before failing — proven below by
// feeding it well-formed, malformed, and empty input alike and observing
// identical, honest failure every time.
//
// Slice 5 continuation — getZatcaSigner() now returns XadesZatcaSigner
// (see tests/zatcaXadesSigner.test.ts for its own real signing/
// verification/negative-case tests). NotImplementedSigner is kept as a
// documented, directly-testable class; only the last test below covers
// the factory itself, so everything else in this file still tests
// NotImplementedSigner directly and remains true of that class.

const WELL_FORMED_XML = '<?xml version="1.0"?><Invoice><cbc:ID>INV-1</cbc:ID></Invoice>';
const MALFORMED_XML = "<Invoice><cbc:ID>unterminated";
const VALID_LOOKING_CREDENTIAL = { binarySecurityToken: "-----BEGIN CERTIFICATE-----MIIB...-----END CERTIFICATE-----", secret: "s3cr3t" };
const GARBAGE_CREDENTIAL = { binarySecurityToken: "", secret: "" };

describe("NotImplementedSigner", () => {
  it("always throws ZatcaNotImplementedError for well-formed XML and a valid-looking credential", async () => {
    const signer = new NotImplementedSigner();
    await expect(signer.sign({ canonicalXml: WELL_FORMED_XML, credential: VALID_LOOKING_CREDENTIAL })).rejects.toBeInstanceOf(
      ZatcaNotImplementedError,
    );
  });

  it("still throws ZatcaNotImplementedError (never a different error) for malformed XML -- it never gets far enough to notice", async () => {
    const signer = new NotImplementedSigner();
    await expect(signer.sign({ canonicalXml: MALFORMED_XML, credential: VALID_LOOKING_CREDENTIAL })).rejects.toBeInstanceOf(
      ZatcaNotImplementedError,
    );
  });

  it("still throws ZatcaNotImplementedError for a garbage/empty credential (invalid cert, invalid key, or both)", async () => {
    const signer = new NotImplementedSigner();
    await expect(signer.sign({ canonicalXml: WELL_FORMED_XML, credential: GARBAGE_CREDENTIAL })).rejects.toBeInstanceOf(
      ZatcaNotImplementedError,
    );
  });

  it("still throws ZatcaNotImplementedError for empty XML entirely (nothing to sign)", async () => {
    const signer = new NotImplementedSigner();
    await expect(signer.sign({ canonicalXml: "", credential: VALID_LOOKING_CREDENTIAL })).rejects.toBeInstanceOf(ZatcaNotImplementedError);
  });

  it("the error category is 'not_implemented', distinguishable from a real cryptographic failure", async () => {
    const signer = new NotImplementedSigner();
    await expect(signer.sign({ canonicalXml: WELL_FORMED_XML, credential: VALID_LOOKING_CREDENTIAL })).rejects.toMatchObject({
      category: "not_implemented",
    });
  });

  it("never returns a truthy result under any circumstance (no fabricated signature)", async () => {
    const signer = new NotImplementedSigner();
    await expect(signer.sign({ canonicalXml: WELL_FORMED_XML, credential: VALID_LOOKING_CREDENTIAL })).rejects.toBeTruthy();
  });

  it("SECRET NON-LEAKAGE: the thrown error message never contains the credential values", async () => {
    const signer = new NotImplementedSigner();
    try {
      await signer.sign({ canonicalXml: WELL_FORMED_XML, credential: VALID_LOOKING_CREDENTIAL });
      throw new Error("expected sign() to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(VALID_LOOKING_CREDENTIAL.binarySecurityToken);
      expect(message).not.toContain(VALID_LOOKING_CREDENTIAL.secret);
    }
  });

  it("getZatcaSigner() factory returns the real XadesZatcaSigner (Slice 5 continuation), not NotImplementedSigner", () => {
    const signer = getZatcaSigner();
    expect(signer).toBeInstanceOf(XadesZatcaSigner);
    expect(signer).not.toBeInstanceOf(NotImplementedSigner);
  });
});
