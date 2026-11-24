/**
 * Minimal, bounded XML element reader for MSBuild project files (`.csproj`,
 * `Directory.Build.props`).
 *
 * Scope: elements, attributes, text, comments, CDATA and processing
 * instructions. Document type declarations are rejected (MSBuild does not
 * accept them either), so no entity can ever be expanded beyond the five
 * predefined XML entities and numeric character references. The reader is a
 * single forward scan (no backtracking regular expressions) with hard limits
 * on nesting depth and element count; any malformed input raises
 * MsbuildXmlError and the caller degrades with an explicit warning.
 */

export interface XmlElement {
  readonly name: string;
  /** Attributes as written (names are case-sensitive in XML). */
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  /** Concatenated direct text content (entities decoded). */
  readonly text: string;
}

export class MsbuildXmlError extends Error {}

const MAX_DEPTH = 64;
const MAX_ELEMENTS = 20_000;

interface MutableElement {
  readonly name: string;
  readonly attributes: Map<string, string>;
  readonly children: MutableElement[];
  text: string;
}

function isNameChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f || // _
    code === 0x2d || // -
    code === 0x2e || // .
    code === 0x3a || // :
    code > 0x7f
  );
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  let out = "";
  let index = 0;
  while (index < raw.length) {
    const amp = raw.indexOf("&", index);
    if (amp < 0) {
      out += raw.slice(index);
      break;
    }
    out += raw.slice(index, amp);
    const semi = raw.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 12) {
      throw new MsbuildXmlError("malformed entity reference");
    }
    const entity = raw.slice(amp + 1, semi);
    switch (entity) {
      case "lt":
        out += "<";
        break;
      case "gt":
        out += ">";
        break;
      case "amp":
        out += "&";
        break;
      case "quot":
        out += '"';
        break;
      case "apos":
        out += "'";
        break;
      default: {
        let codePoint = Number.NaN;
        if (entity.startsWith("#x") || entity.startsWith("#X")) {
          const hex = entity.slice(2);
          if (/^[0-9a-fA-F]{1,6}$/.test(hex)) codePoint = Number.parseInt(hex, 16);
        } else if (entity.startsWith("#")) {
          const dec = entity.slice(1);
          if (/^[0-9]{1,7}$/.test(dec)) codePoint = Number.parseInt(dec, 10);
        }
        if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10ffff) {
          throw new MsbuildXmlError(`unsupported entity reference: &${entity};`);
        }
        out += String.fromCodePoint(codePoint);
      }
    }
    index = semi + 1;
  }
  return out;
}

/** Parses one XML document and returns its root element. */
export function parseMsbuildXml(source: string): XmlElement {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const stack: MutableElement[] = [];
  let root: MutableElement | null = null;
  let elementCount = 0;
  let index = 0;

  const expectClose = (marker: string, from: number, what: string): number => {
    const end = text.indexOf(marker, from);
    if (end < 0) throw new MsbuildXmlError(`unterminated ${what}`);
    return end;
  };

  while (index < text.length) {
    const lt = text.indexOf("<", index);
    const chunk = lt < 0 ? text.slice(index) : text.slice(index, lt);
    if (chunk.length > 0) {
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        top.text += decodeEntities(chunk);
      } else if (chunk.trim().length > 0) {
        throw new MsbuildXmlError("text outside the root element");
      }
    }
    if (lt < 0) break;

    if (text.startsWith("<!--", lt)) {
      index = expectClose("-->", lt + 4, "comment") + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = expectClose("]]>", lt + 9, "CDATA section");
      const top = stack[stack.length - 1];
      if (top === undefined) throw new MsbuildXmlError("CDATA outside the root element");
      top.text += text.slice(lt + 9, end);
      index = end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      index = expectClose("?>", lt + 2, "processing instruction") + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      throw new MsbuildXmlError("document type declarations are not supported");
    }

    if (text.startsWith("</", lt)) {
      let cursor = lt + 2;
      const nameStart = cursor;
      while (cursor < text.length && isNameChar(text.charCodeAt(cursor))) cursor += 1;
      const name = text.slice(nameStart, cursor);
      while (cursor < text.length && isWhitespace(text.charCodeAt(cursor))) cursor += 1;
      if (text.charCodeAt(cursor) !== 0x3e) throw new MsbuildXmlError("malformed end tag");
      const top = stack.pop();
      if (top === undefined || top.name !== name) {
        throw new MsbuildXmlError(`mismatched end tag </${name}>`);
      }
      index = cursor + 1;
      continue;
    }

    // Start tag.
    let cursor = lt + 1;
    const nameStart = cursor;
    while (cursor < text.length && isNameChar(text.charCodeAt(cursor))) cursor += 1;
    const name = text.slice(nameStart, cursor);
    if (name.length === 0) throw new MsbuildXmlError("malformed start tag");
    const attributes = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      while (cursor < text.length && isWhitespace(text.charCodeAt(cursor))) cursor += 1;
      if (cursor >= text.length) throw new MsbuildXmlError("unterminated start tag");
      const code = text.charCodeAt(cursor);
      if (code === 0x3e) {
        cursor += 1;
        break;
      }
      if (code === 0x2f) {
        if (text.charCodeAt(cursor + 1) !== 0x3e) throw new MsbuildXmlError("malformed self-closing tag");
        selfClosing = true;
        cursor += 2;
        break;
      }
      const attrStart = cursor;
      while (cursor < text.length && isNameChar(text.charCodeAt(cursor))) cursor += 1;
      const attrName = text.slice(attrStart, cursor);
      if (attrName.length === 0) throw new MsbuildXmlError("malformed attribute");
      while (cursor < text.length && isWhitespace(text.charCodeAt(cursor))) cursor += 1;
      if (text.charCodeAt(cursor) !== 0x3d) throw new MsbuildXmlError("attribute without a value");
      cursor += 1;
      while (cursor < text.length && isWhitespace(text.charCodeAt(cursor))) cursor += 1;
      const quote = text[cursor];
      if (quote !== '"' && quote !== "'") throw new MsbuildXmlError("unquoted attribute value");
      const valueEnd = text.indexOf(quote, cursor + 1);
      if (valueEnd < 0) throw new MsbuildXmlError("unterminated attribute value");
      const rawValue = text.slice(cursor + 1, valueEnd);
      if (rawValue.includes("<")) throw new MsbuildXmlError("'<' inside an attribute value");
      if (attributes.has(attrName)) throw new MsbuildXmlError(`duplicate attribute ${attrName}`);
      attributes.set(attrName, decodeEntities(rawValue));
      cursor = valueEnd + 1;
    }

    elementCount += 1;
    if (elementCount > MAX_ELEMENTS) throw new MsbuildXmlError("element count limit exceeded");
    const element: MutableElement = { name, attributes, children: [], text: "" };
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.children.push(element);
    } else if (root === null) {
      root = element;
    } else {
      throw new MsbuildXmlError("more than one root element");
    }
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > MAX_DEPTH) throw new MsbuildXmlError("nesting depth limit exceeded");
    }
    index = cursor;
  }

  if (stack.length > 0) throw new MsbuildXmlError(`unclosed element <${stack[stack.length - 1]?.name ?? ""}>`);
  if (root === null) throw new MsbuildXmlError("no root element");
  return root;
}
