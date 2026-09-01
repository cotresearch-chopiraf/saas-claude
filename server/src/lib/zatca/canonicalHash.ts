// Real ZATCA invoice-XML hash canonicalization — Slice 5 continuation.
//
// VERIFICATION STATUS: the removal-then-canonicalize-then-hash SEQUENCE
// (remove UBLExtensions / the QR AdditionalDocumentReference / Signature,
// strip the XML declaration, canonicalize, SHA-256, Base64) is
// USER-SUPPLIED as the specification baseline for this continuation — see
// docs/zatca/SLICE5_OFFICIAL_SPEC_VERIFICATION.md. It is NOT independently
// verified by this codebase against zatca.gov.sa's Security Features
// Implementation Standard, which remains unreachable from this
// environment. The exact XPath predicates ZATCA itself specifies for
// locating these elements were not supplied — this module instead matches
// elements against MIDAD's own known XML shape (see xmlBuilder.ts):
// `ext:UBLExtensions`, a `cac:AdditionalDocumentReference` whose `cbc:ID`
// text is exactly "QR", and any `Signature` element in the XMLDSig
// namespace. That is a documented gap, not a guess about ZATCA's XPath.
//
// Canonicalization uses xml-crypto's C14nCanonicalization (base Canonical
// XML 1.0, REC-xml-c14n-20010315) rather than C14N 1.1. The two algorithms
// differ only in how they treat xml:lang/xml:space/xml:base/xml:id
// attributes inherited from ancestor elements OUTSIDE the canonicalized
// subset. MIDAD's generated invoice XML (xmlBuilder.ts) never emits any
// `xml:`-prefixed attribute, and this function always canonicalizes the
// complete, self-contained root <Invoice> element (never a subset with
// external ancestor context) — so the two algorithms produce identical
// output for every document this function will ever see. This is an
// engineering judgment about MIDAD's own document shape, not a verified
// claim about which algorithm zatca.gov.sa's own spec text requires (that
// spec text — www.w3.org/TR/xml-c14n11/ included — is also unreachable
// from this environment). If this is ever wrong, it fails LOUD (a hash
// mismatch against a real ZATCA response), never silently.

import { createHash } from "crypto";
import { DOMParser } from "@xmldom/xmldom";
import { C14nCanonicalization } from "xml-crypto";
import { ZatcaInternalError } from "./errors.js";

const UBL_EXTENSIONS_NS = "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2";
const CAC_NS = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";
const CBC_NS = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
const XMLDSIG_NS = "http://www.w3.org/2000/09/xmldsig#";

// A minimal structural type for the exact subset of the DOM API this file
// uses, deliberately NOT the ambient global `Document`/`Element` types.
// This monorepo hoists multiple independent DOM-typed packages (xmldom,
// jsdom, xml-crypto, @types/react) into one shared node_modules tree, and
// nothing here depends on which physical copy's ambient types happen to
// win — only on the real, runtime-verified shape @xmldom/xmldom's parser
// actually returns (verified directly against its parsed output before
// this code was written).
interface DomLikeNode {
  parentNode: DomLikeNode | null;
  removeChild(child: DomLikeNode): DomLikeNode;
  textContent: string | null;
  getElementsByTagNameNS(namespaceURI: string, localName: string): ArrayLike<DomLikeNode>;
}
interface DomLikeDocument extends DomLikeNode {
  documentElement: DomLikeNode;
}

function removeAllByTagNameNS(doc: DomLikeDocument, namespaceURI: string, localName: string): void {
  // Snapshot to an array first — getElementsByTagNameNS returns a live
  // collection in some DOM implementations, and mutating while iterating
  // a live collection silently skips elements.
  const nodes = Array.from(doc.getElementsByTagNameNS(namespaceURI, localName));
  for (const node of nodes) {
    node.parentNode?.removeChild(node);
  }
}

function removeQrAdditionalDocumentReference(doc: DomLikeDocument): void {
  const refs = Array.from(doc.getElementsByTagNameNS(CAC_NS, "AdditionalDocumentReference"));
  for (const ref of refs) {
    const idEl = ref.getElementsByTagNameNS(CBC_NS, "ID")[0];
    if (idEl?.textContent === "QR") {
      ref.parentNode?.removeChild(ref);
    }
  }
}

// Removes the pre-signature elements ZATCA's hash contract excludes (per
// the user-supplied baseline), then canonicalizes and hashes what remains.
//
// Idempotent and safe to call on XML that does not yet contain any of
// these elements (true for every document MIDAD currently generates,
// since no signer inserts them yet) — removal is a no-op in that case, and
// the function still canonicalizes + hashes the document.
export function computeCanonicalInvoiceHash(xml: string): string {
  let doc: DomLikeDocument;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as DomLikeDocument;
  } catch (err) {
    throw new ZatcaInternalError(
      `Failed to parse invoice XML for canonicalization: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!doc?.documentElement) {
    throw new ZatcaInternalError("Failed to parse invoice XML for canonicalization: no root element");
  }

  removeAllByTagNameNS(doc, UBL_EXTENSIONS_NS, "UBLExtensions");
  removeQrAdditionalDocumentReference(doc);
  removeAllByTagNameNS(doc, XMLDSIG_NS, "Signature");

  // C14N never emits an XML declaration/prolog by definition — processing
  // the root element (rather than re-serializing with our own
  // renderXmlDocument, which does add one) achieves "strip the XML
  // declaration" as a natural consequence of canonicalization, not a
  // separate string-manipulation step.
  const canonicalXml = new C14nCanonicalization().process(doc.documentElement as unknown as Node, {});

  return createHash("sha256").update(canonicalXml, "utf8").digest("base64");
}
