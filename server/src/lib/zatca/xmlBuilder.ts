// UBL 2.1 Invoice XML builder for ZATCA e-invoicing.
//
// Pure function: CanonicalZatcaDocument in, XML string out. No I/O, no DB,
// no network, no randomness (the caller supplies uuid/hash/counter). Not
// wired into any route — see types.ts's file-level comment.
//
// The base element structure (cbc:ID, cbc:UUID, cbc:IssueDate,
// cac:AccountingSupplierParty, cac:InvoiceLine, cac:LegalMonetaryTotal,
// etc.) follows the UBL 2.1 / EN16931 international standard, which is
// stable and publicly documented independent of ZATCA. The ZATCA-specific
// customizations — InvoiceTypeCode's `name` attribute encoding, and
// AdditionalDocumentReference entries for ICV/PIH — are cross-corroborated
// across many independent secondary sources but UNVERIFIED against the
// primary ZATCA XSD/Schematron (blocked from fetching zatca.gov.sa in this
// environment — see docs/ZATCA_IMPLEMENTATION_STATUS.md). Do not represent
// XML produced by this module as ZATCA-approved or SDK-validated.

import type { CanonicalZatcaDocument, ZatcaParty, ZatcaTaxCategoryCode } from "./types.js";
import { el, renderXmlDocument, type XmlElement, type XmlNode } from "./xmlSafety.js";

const UBL_NAMESPACES = {
  xmlns: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  "xmlns:cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  "xmlns:cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  "xmlns:ext": "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
};

// Cross-corroborated ZATCA InvoiceTypeCode `name` attribute encoding:
// "0100000" = standard (B2B, Clearance), "0200000" = simplified (B2C,
// Reporting). See types.ts's ZatcaInvoiceSubtype comment.
const SUBTYPE_NAME_ATTRIBUTE: Record<CanonicalZatcaDocument["subtype"], string> = {
  standard: "0100000",
  simplified: "0200000",
};

// UNTGC5153-style tax scheme identifier for VAT — standard EN16931 value,
// not ZATCA-specific.
const VAT_TAX_SCHEME = el("cac:TaxScheme", [el("cbc:ID", ["VAT"])]);

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

function amountEl(tag: string, amount: number, currencyCode: string): XmlElement {
  return el(tag, { currencyID: currencyCode }, [formatAmount(amount)]);
}

function buildPartyAddress(party: ZatcaParty): XmlElement | null {
  if (!party.address) return null;
  const a = party.address;
  return el("cac:PostalAddress", [
    a.streetName ? el("cbc:StreetName", [a.streetName]) : null,
    a.buildingNumber ? el("cbc:BuildingNumber", [a.buildingNumber]) : null,
    a.additionalStreetName ? el("cbc:AdditionalStreetName", [a.additionalStreetName]) : null,
    a.citySubdivisionName ? el("cbc:CitySubdivisionName", [a.citySubdivisionName]) : null,
    a.cityName ? el("cbc:CityName", [a.cityName]) : null,
    a.postalZone ? el("cbc:PostalZone", [a.postalZone]) : null,
    a.countrySubentity ? el("cbc:CountrySubentity", [a.countrySubentity]) : null,
    el("cac:Country", [el("cbc:IdentificationCode", [a.countryCode])]),
  ]);
}

function buildParty(party: ZatcaParty): XmlElement {
  return el("cac:Party", [
    party.vatNumber
      ? el("cac:PartyTaxScheme", [el("cbc:CompanyID", [party.vatNumber]), VAT_TAX_SCHEME])
      : null,
    el("cac:PartyLegalEntity", [
      el("cbc:RegistrationName", [party.registrationName]),
      party.commercialRegistrationNumber ? el("cbc:CompanyID", [party.commercialRegistrationNumber]) : null,
    ]),
    buildPartyAddress(party),
  ]);
}

function buildAdditionalDocumentReference(id: string, value: string): XmlElement {
  // Cross-corroborated placement for ICV/PIH — see file-level disclaimer.
  return el("cac:AdditionalDocumentReference", [el("cbc:ID", [id]), el("cbc:UUID", [value])]);
}

function buildTaxSubtotal(subtotal: CanonicalZatcaDocument["taxSubtotals"][number], currencyCode: string): XmlElement {
  return el("cac:TaxSubtotal", [
    amountEl("cbc:TaxableAmount", subtotal.taxableAmount, currencyCode),
    amountEl("cbc:TaxAmount", subtotal.taxAmount, currencyCode),
    el("cac:TaxCategory", [
      el("cbc:ID", [subtotal.taxCategoryCode]),
      el("cbc:Percent", [formatAmount(subtotal.taxRatePercent)]),
      VAT_TAX_SCHEME,
    ]),
  ]);
}

function buildInvoiceLine(line: CanonicalZatcaDocument["lines"][number], currencyCode: string): XmlElement {
  return el("cac:InvoiceLine", [
    el("cbc:ID", [line.id]),
    el("cbc:InvoicedQuantity", [String(line.quantity)]),
    amountEl("cbc:LineExtensionAmount", line.lineExtensionAmount, currencyCode),
    el("cac:TaxTotal", [
      amountEl("cbc:TaxAmount", line.taxAmount, currencyCode),
      el("cac:TaxSubtotal", [
        amountEl("cbc:TaxableAmount", line.lineExtensionAmount, currencyCode),
        amountEl("cbc:TaxAmount", line.taxAmount, currencyCode),
        el("cac:TaxCategory", [
          el("cbc:ID", [line.taxCategoryCode]),
          el("cbc:Percent", [formatAmount(line.taxRatePercent)]),
          VAT_TAX_SCHEME,
        ]),
      ]),
    ]),
    el("cac:Item", [
      el("cbc:Name", [line.description]),
      el("cac:ClassifiedTaxCategory", [
        el("cbc:ID", [line.taxCategoryCode]),
        el("cbc:Percent", [formatAmount(line.taxRatePercent)]),
        VAT_TAX_SCHEME,
      ]),
    ]),
    el("cac:Price", [amountEl("cbc:PriceAmount", line.unitPrice, currencyCode)]),
  ]);
}

export function buildZatcaInvoiceXml(doc: CanonicalZatcaDocument): string {
  const children: XmlNode[] = [
    el("cbc:ProfileID", [doc.subtype === "simplified" ? "reporting:1.0" : "clearance:1.0"]),
    el("cbc:ID", [doc.id]),
    el("cbc:UUID", [doc.uuid]),
    el("cbc:IssueDate", [doc.issueDate]),
    el("cbc:IssueTime", [doc.issueTime]),
    el("cbc:InvoiceTypeCode", { name: SUBTYPE_NAME_ATTRIBUTE[doc.subtype] }, [doc.documentTypeCode]),
    doc.note ? el("cbc:Note", [doc.note]) : null,
    el("cbc:DocumentCurrencyCode", [doc.currencyCode]),
    el("cbc:TaxCurrencyCode", [doc.currencyCode]),
    doc.billingReference
      ? el("cac:BillingReference", [
          el("cac:InvoiceDocumentReference", [
            el("cbc:ID", [doc.billingReference.invoiceId]),
            el("cbc:IssueDate", [doc.billingReference.issueDate]),
          ]),
        ])
      : null,
    buildAdditionalDocumentReference("ICV", String(doc.invoiceCounterValue)),
    buildAdditionalDocumentReference("PIH", doc.previousInvoiceHash),
    el("cac:AccountingSupplierParty", [buildParty(doc.supplier)]),
    doc.customer ? el("cac:AccountingCustomerParty", [buildParty(doc.customer)]) : null,
    el("cac:TaxTotal", [
      amountEl("cbc:TaxAmount", doc.totalTaxAmount, doc.currencyCode),
      ...doc.taxSubtotals.map((s) => buildTaxSubtotal(s, doc.currencyCode)),
    ]),
  ];

  children.push(
    el("cac:LegalMonetaryTotal", [
      amountEl("cbc:LineExtensionAmount", doc.taxExclusiveAmount, doc.currencyCode),
      amountEl("cbc:TaxExclusiveAmount", doc.taxExclusiveAmount, doc.currencyCode),
      amountEl("cbc:TaxInclusiveAmount", doc.taxInclusiveAmount, doc.currencyCode),
      amountEl("cbc:PayableAmount", doc.payableAmount, doc.currencyCode),
    ]),
  );
  for (const line of doc.lines) {
    children.push(buildInvoiceLine(line, doc.currencyCode));
  }

  const root = el("Invoice", UBL_NAMESPACES, children);
  return renderXmlDocument(root);
}
