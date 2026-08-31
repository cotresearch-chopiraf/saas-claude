// A minimal, safe XML element builder — deliberately not raw template-string
// concatenation of untrusted values (invoice line descriptions, client
// names, etc. are user-supplied text and must never be interpolated into
// XML unescaped). Every text/attribute value passed through this module is
// escaped; there is no code path here that emits a value verbatim.

export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export type XmlAttributes = Record<string, string>;

// A node is either: text content, or an element with optional attributes
// and children (nested elements or more text). `null`/`undefined` children
// are dropped, so an optional field can be included conditionally without
// the caller needing to branch on array construction.
export type XmlNode = string | XmlElement | null | undefined;

export interface XmlElement {
  tag: string;
  attributes?: XmlAttributes;
  children?: XmlNode[];
  // Self-closing when there are no children at all (distinct from an
  // element with only an empty string child, which renders <tag></tag>).
}

export function el(tag: string, attributesOrChildren?: XmlAttributes | XmlNode[], maybeChildren?: XmlNode[]): XmlElement {
  if (Array.isArray(attributesOrChildren)) {
    return { tag, children: attributesOrChildren };
  }
  return { tag, attributes: attributesOrChildren, children: maybeChildren };
}

function renderAttributes(attributes?: XmlAttributes): string {
  if (!attributes) return "";
  return Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`)
    .join("");
}

export function renderXmlNode(node: XmlNode): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return escapeXmlText(node);

  const attrs = renderAttributes(node.attributes);
  if (!node.children || node.children.length === 0) {
    return `<${node.tag}${attrs}/>`;
  }
  const inner = node.children.map(renderXmlNode).join("");
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

export function renderXmlDocument(root: XmlElement): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderXmlNode(root)}`;
}
