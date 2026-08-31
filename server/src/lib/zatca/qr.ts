// ZATCA QR code payload — Tag-Length-Value (TLV) encoding, Base64 output.
//
// Pure functions: raw field values in, Base64 TLV string out. No QR image
// rendering here (that's a separate, later concern — this module only
// produces the payload a QR image encoder would render).
//
// VERIFICATION STATUS: the TLV mechanics (tag byte, one-byte UTF-8 byte
// length, value bytes) and the specific tag numbers below are
// cross-corroborated across many independent secondary sources describing
// the official "Guide to Developed FATOORA Compliant QR Code" — this
// environment cannot fetch zatca.gov.sa directly to read the primary PDF.
// Treat tag semantics as unverified-but-consensus, matching the same
// disclaimer already used in lib/compliance/packs/saudiArabia.ts.
//
// Phase 1 tags (5 fields, all invoice types):
//   1 = Seller name, 2 = VAT registration number, 3 = Timestamp (ISO 8601),
//   4 = Invoice total (with VAT), 5 = VAT total.
// Phase 2 adds (simplified/B2C invoices, populated only after a real
// ZATCA clearance/reporting response — never fabricated locally):
//   6 = XML invoice hash (Base64 SHA-256), 7 = ECDSA signature,
//   8 = ECDSA public key, 9 = ZATCA certificate signature of the public key.

export const ZATCA_QR_TAG = {
  sellerName: 1,
  vatRegistrationNumber: 2,
  timestamp: 3,
  invoiceTotal: 4,
  vatTotal: 5,
  invoiceXmlHash: 6,
  ecdsaSignature: 7,
  ecdsaPublicKey: 8,
  certificateSignature: 9,
} as const;

export type ZatcaQrTag = (typeof ZATCA_QR_TAG)[keyof typeof ZATCA_QR_TAG];

export interface ZatcaQrField {
  tag: ZatcaQrTag;
  // Text fields are UTF-8 strings (seller name may be Arabic); the
  // cryptographic fields (6-9) carry raw bytes, already base64-decoded by
  // the caller if that's how they arrived — this module only cares about
  // the byte length of whatever Buffer it's given.
  value: string | Buffer;
}

// One TLV entry: [tag byte][length byte][value bytes]. Length is the
// UTF-8/raw byte count, not the character count — this is the single most
// commonly cited Phase 2 rejection cause (Arabic/multi-byte text miscounted
// as character length instead of byte length), so it is tested explicitly.
function encodeField(field: ZatcaQrField): Buffer {
  const valueBytes = Buffer.isBuffer(field.value) ? field.value : Buffer.from(field.value, "utf-8");
  if (valueBytes.length > 255) {
    throw new Error(`ZATCA QR field ${field.tag} exceeds the one-byte TLV length limit (${valueBytes.length} bytes)`);
  }
  return Buffer.concat([Buffer.from([field.tag]), Buffer.from([valueBytes.length]), valueBytes]);
}

export function buildZatcaQrPayload(fields: ZatcaQrField[]): string {
  const buffers = fields.map(encodeField);
  return Buffer.concat(buffers).toString("base64");
}

export interface ZatcaPhase1QrInput {
  sellerName: string;
  vatRegistrationNumber: string;
  // ISO 8601, e.g. "2026-08-31T12:13:57" — caller supplies it (this module
  // performs no clock reads, staying a pure function).
  timestamp: string;
  invoiceTotal: string;
  vatTotal: string;
}

export function buildPhase1QrPayload(input: ZatcaPhase1QrInput): string {
  return buildZatcaQrPayload([
    { tag: ZATCA_QR_TAG.sellerName, value: input.sellerName },
    { tag: ZATCA_QR_TAG.vatRegistrationNumber, value: input.vatRegistrationNumber },
    { tag: ZATCA_QR_TAG.timestamp, value: input.timestamp },
    { tag: ZATCA_QR_TAG.invoiceTotal, value: input.invoiceTotal },
    { tag: ZATCA_QR_TAG.vatTotal, value: input.vatTotal },
  ]);
}

export interface ZatcaPhase2QrInput extends ZatcaPhase1QrInput {
  // These four fields can only be populated from a REAL ZATCA
  // clearance/reporting response and a real CSID-backed signature — never
  // generate them locally. Left as required (not optional) so a caller
  // cannot accidentally build a "Phase 2" payload with placeholder/fake
  // cryptographic material; there is deliberately no default or mock value
  // anywhere in this module.
  invoiceXmlHash: Buffer;
  ecdsaSignature: Buffer;
  ecdsaPublicKey: Buffer;
  certificateSignature: Buffer;
}

export function buildPhase2QrPayload(input: ZatcaPhase2QrInput): string {
  return buildZatcaQrPayload([
    { tag: ZATCA_QR_TAG.sellerName, value: input.sellerName },
    { tag: ZATCA_QR_TAG.vatRegistrationNumber, value: input.vatRegistrationNumber },
    { tag: ZATCA_QR_TAG.timestamp, value: input.timestamp },
    { tag: ZATCA_QR_TAG.invoiceTotal, value: input.invoiceTotal },
    { tag: ZATCA_QR_TAG.vatTotal, value: input.vatTotal },
    { tag: ZATCA_QR_TAG.invoiceXmlHash, value: input.invoiceXmlHash },
    { tag: ZATCA_QR_TAG.ecdsaSignature, value: input.ecdsaSignature },
    { tag: ZATCA_QR_TAG.ecdsaPublicKey, value: input.ecdsaPublicKey },
    { tag: ZATCA_QR_TAG.certificateSignature, value: input.certificateSignature },
  ]);
}
