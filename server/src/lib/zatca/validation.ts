// ZATCA document validation — deliberately split into two independent
// layers that must never be conflated:
//
// 1. STRUCTURAL validation: is the XML well-formed, are the elements this
//    module itself claims to produce actually present. Fully verifiable
//    from first principles (XML syntax), no ZATCA-specific knowledge
//    required, and NOT a substitute for real business-rule checking.
//
// 2. ARITHMETIC business rules: a small, explicitly enumerated set of
//    accounting identities (line totals sum to the tax-exclusive amount,
//    tax-exclusive + tax = tax-inclusive) that are mathematically
//    necessary for ANY correct invoice, cross-corroborated as ZATCA
//    BR-CO-style rules, but this is NOT the full ZATCA BR-KSA rule set —
//    per the master prompt's explicit instruction not to write "hundreds
//    of guessed rules," this file does not attempt to reimplement ZATCA's
//    Schematron. `sdkVerified` is always `false` here; only a real run of
//    the official ZATCA SDK/validator may ever set it true, and that must
//    be recorded with the SDK/XSD/Schematron version per
//    docs/ZATCA_IMPLEMENTATION_STATUS.md.

import type { CanonicalZatcaDocument } from "./types.js";

export interface ZatcaValidationIssue {
  code: string;
  message: string;
}

export interface ZatcaValidationResult {
  valid: boolean;
  errors: ZatcaValidationIssue[];
  warnings: ZatcaValidationIssue[];
  // Always false in this module — see file-level comment. A caller must
  // never report this result as "ZATCA validated" without also recording a
  // real SDK run.
  sdkVerified: false;
}

// Minimal, dependency-free well-formedness check: every opening tag has a
// matching close (or is self-closing), tags nest correctly, and there is
// exactly one root element. This is real XML-syntax verification, not a
// ZATCA-specific check.
export function checkXmlWellFormed(xml: string): ZatcaValidationIssue[] {
  const errors: ZatcaValidationIssue[] = [];
  // Attributes are matched explicitly as quoted name="value" pairs so a
  // trailing self-closing "/" is never accidentally absorbed into a
  // greedy attribute-content match (this codebase's own xmlSafety.ts
  // always emits quoted attributes, so this is precise for our own XML).
  const tagPattern = /<(\/?)([a-zA-Z_][\w:.-]*)((?:\s+[a-zA-Z_][\w:.-]*\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  const stack: string[] = [];
  let rootCount = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(xml)) !== null) {
    const [, isClosing, tagName, , isSelfClosing] = match;
    if (isSelfClosing) {
      if (stack.length === 0) rootCount++;
      continue;
    }
    if (isClosing) {
      const expected = stack.pop();
      if (expected !== tagName) {
        errors.push({
          code: "XML_MISMATCHED_TAG",
          message: `Expected closing tag for "${expected ?? "(none)"}" but found "</${tagName}>"`,
        });
      }
    } else {
      if (stack.length === 0) rootCount++;
      stack.push(tagName);
    }
  }

  if (stack.length > 0) {
    errors.push({ code: "XML_UNCLOSED_TAG", message: `Unclosed tag(s): ${stack.join(", ")}` });
  }
  if (rootCount === 0) {
    errors.push({ code: "XML_NO_ROOT_ELEMENT", message: "No root element found" });
  } else if (rootCount > 1) {
    errors.push({ code: "XML_MULTIPLE_ROOT_ELEMENTS", message: `Found ${rootCount} root-level elements, expected exactly 1` });
  }

  return errors;
}

export function checkRequiredElementsPresent(xml: string, requiredTagNames: string[]): ZatcaValidationIssue[] {
  return requiredTagNames
    .filter((tag) => !new RegExp(`<${tag}(\\s|>|/>)`).test(xml))
    .map((tag) => ({ code: "XML_MISSING_REQUIRED_ELEMENT", message: `Required element <${tag}> not found` }));
}

const AMOUNT_TOLERANCE = 0.01; // one cent, matching money.ts's cent precision

function roughlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < AMOUNT_TOLERANCE;
}

// The small, explicitly-enumerated arithmetic rule set — see file-level
// comment for why this is not a full BR-KSA implementation.
export function validateDocumentArithmetic(doc: CanonicalZatcaDocument): ZatcaValidationIssue[] {
  const errors: ZatcaValidationIssue[] = [];

  const lineSum = doc.lines.reduce((sum, line) => sum + line.lineExtensionAmount, 0);
  if (!roughlyEqual(lineSum, doc.taxExclusiveAmount)) {
    errors.push({
      code: "ARITH_LINE_SUM_MISMATCH",
      message: `Sum of line extension amounts (${lineSum.toFixed(2)}) does not equal taxExclusiveAmount (${doc.taxExclusiveAmount.toFixed(2)})`,
    });
  }

  const subtotalTaxSum = doc.taxSubtotals.reduce((sum, s) => sum + s.taxAmount, 0);
  if (!roughlyEqual(subtotalTaxSum, doc.totalTaxAmount)) {
    errors.push({
      code: "ARITH_TAX_SUBTOTAL_MISMATCH",
      message: `Sum of tax subtotal amounts (${subtotalTaxSum.toFixed(2)}) does not equal totalTaxAmount (${doc.totalTaxAmount.toFixed(2)})`,
    });
  }

  const expectedInclusive = doc.taxExclusiveAmount + doc.totalTaxAmount;
  if (!roughlyEqual(expectedInclusive, doc.taxInclusiveAmount)) {
    errors.push({
      code: "ARITH_TAX_INCLUSIVE_MISMATCH",
      message: `taxExclusiveAmount + totalTaxAmount (${expectedInclusive.toFixed(2)}) does not equal taxInclusiveAmount (${doc.taxInclusiveAmount.toFixed(2)})`,
    });
  }

  if (!roughlyEqual(doc.taxInclusiveAmount, doc.payableAmount)) {
    errors.push({
      code: "ARITH_PAYABLE_MISMATCH",
      message: `taxInclusiveAmount (${doc.taxInclusiveAmount.toFixed(2)}) does not equal payableAmount (${doc.payableAmount.toFixed(2)})`,
    });
  }

  if (doc.documentTypeCode !== "388" && !doc.billingReference) {
    errors.push({
      code: "MISSING_BILLING_REFERENCE",
      message: `Document type ${doc.documentTypeCode} (credit/debit note) requires a billingReference to the original invoice`,
    });
  }

  return errors;
}

export const ZATCA_REQUIRED_ELEMENTS = [
  "cbc:ID",
  "cbc:UUID",
  "cbc:IssueDate",
  "cbc:InvoiceTypeCode",
  "cbc:DocumentCurrencyCode",
  "cac:AccountingSupplierParty",
  "cac:TaxTotal",
  "cac:LegalMonetaryTotal",
];

export function validateZatcaDocument(xml: string, doc: CanonicalZatcaDocument): ZatcaValidationResult {
  const structuralErrors = checkXmlWellFormed(xml);
  const missingElementErrors = structuralErrors.length === 0 ? checkRequiredElementsPresent(xml, ZATCA_REQUIRED_ELEMENTS) : [];
  const arithmeticErrors = validateDocumentArithmetic(doc);

  const errors = [...structuralErrors, ...missingElementErrors, ...arithmeticErrors];
  const warnings: ZatcaValidationIssue[] = [
    {
      code: "UNVERIFIED_BR_KSA_RULES",
      message:
        "This validator checks XML well-formedness and basic arithmetic identities only. It does NOT implement ZATCA's full BR-KSA business-rule set or XSD/Schematron — those require the official ZATCA SDK, which has not been run against this document.",
    },
  ];

  return { valid: errors.length === 0, errors, warnings, sdkVerified: false };
}
