import { describe, it, expect } from "vitest";
import { escapeXmlText, escapeXmlAttribute, el, renderXmlNode, renderXmlDocument } from "../src/lib/zatca/xmlSafety.js";

describe("zatca xmlSafety — escaping", () => {
  it("escapes all five XML-significant characters in text content", () => {
    expect(escapeXmlText(`<a> & "b" 'c'`)).toBe("&lt;a&gt; &amp; \"b\" 'c'");
  });

  it("escapes attribute values including quotes", () => {
    expect(escapeXmlAttribute(`He said "hi" & <bye>`)).toBe("He said &quot;hi&quot; &amp; &lt;bye&gt;");
    expect(escapeXmlAttribute(`it's`)).toBe("it&apos;s");
  });

  it("escapes newlines and carriage returns in text", () => {
    expect(escapeXmlText("line1\nline2\rline3")).toBe("line1&#10;line2&#13;line3");
  });

  it("never emits unescaped user-controlled text — a crafted description cannot break out of an element", () => {
    const malicious = `Widget</cbc:Name><Injected>evil`;
    const rendered = renderXmlNode(el("cbc:Name", [malicious]));
    expect(rendered).not.toContain("</cbc:Name><Injected>");
    expect(rendered).toBe("<cbc:Name>Widget&lt;/cbc:Name&gt;&lt;Injected&gt;evil</cbc:Name>");
  });
});

describe("zatca xmlSafety — element rendering", () => {
  it("renders a self-closing element when there are no children", () => {
    expect(renderXmlNode(el("cbc:Empty"))).toBe("<cbc:Empty/>");
  });

  it("renders nested elements with text content", () => {
    const node = el("cac:Party", [el("cbc:Name", ["Acme"])]);
    expect(renderXmlNode(node)).toBe("<cac:Party><cbc:Name>Acme</cbc:Name></cac:Party>");
  });

  it("renders attributes with proper escaping", () => {
    const node = el("cbc:InvoiceTypeCode", { name: "0100000" }, ["388"]);
    expect(renderXmlNode(node)).toBe('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');
  });

  it("drops null/undefined children without rendering anything for them", () => {
    const node = el("cac:Optional", [null, el("cbc:Present", ["x"]), undefined]);
    expect(renderXmlNode(node)).toBe("<cac:Optional><cbc:Present>x</cbc:Present></cac:Optional>");
  });

  it("renders a full document with an XML declaration", () => {
    const doc = renderXmlDocument(el("Invoice", [el("cbc:ID", ["INV-1"])]));
    expect(doc).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Invoice><cbc:ID>INV-1</cbc:ID></Invoice>');
  });
});
