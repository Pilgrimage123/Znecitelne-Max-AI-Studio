function decodeOdtXmlEntities(str) {
  if (!str || !str.includes("&")) return str;
  return str
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return (cp >= 0 && cp <= 0x10FFFF) ? String.fromCodePoint(cp) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const cp = parseInt(hex, 16);
      return (cp >= 0 && cp <= 0x10FFFF) ? String.fromCodePoint(cp) : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseOdtXmlPart(xml) {
  if (!xml) return [];
  if (typeof DOMParser === "undefined") {
    const paragraphs = [];
    const reP = /<text:[ph](?:\s[^>]*)?>([\s\S]*?)<\/text:[ph]>/gi;
    let pm;
    while ((pm = reP.exec(xml)) !== null) {
      const pXml = pm[1];
      const pText = decodeOdtXmlEntities(
        pXml
          .replace(/<text:tab(?:\s[^>]*)?\/>/gi, "\t")
          .replace(/<text:line-break(?:\s[^>]*)?\/>/gi, "\n")
          .replace(/<text:s\s+[^>]*?(?:text:)?c="(\d+)"[^>]*?\/>/gi, (_, c) => " ".repeat(Math.max(1, parseInt(c, 10) || 1)))
          .replace(/<text:s(?:\s[^>]*)?\/>/gi, " ")
          .replace(/<[^>]+>/g, "")
      );
      if (pText.trim()) paragraphs.push(pText.trim());
    }
    return paragraphs;
  }
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Chyba XML v ODT");
  const TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
  const walkNode = (node) => {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    const name = node.localName;
    if (name === "tab") return "\t";
    if (name === "line-break") return "\n";
    if (name === "s") {
      const rawC = node.getAttribute("text:c") || node.getAttribute("c") || node.getAttributeNS(TEXT_NS, "c") || "1";
      const count = parseInt(rawC, 10);
      return " ".repeat(Math.max(1, Number.isFinite(count) ? count : 1));
    }
    let acc = "";
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && (c.localName === "p" || c.localName === "h")) continue;
      acc += walkNode(c);
    }
    return acc;
  };
  const elements = Array.from(doc.getElementsByTagNameNS("*", "*")).filter(n => {
    const name = n.localName;
    return name === "p" || name === "h";
  });
  return elements.map(el => walkNode(el).trim()).filter(Boolean);
}

export function extractOdtText(buf){
  const flate = (typeof window !== "undefined" && window.fflate) || (typeof globalThis !== "undefined" && globalThis.fflate) || (typeof fflate !== "undefined" ? fflate : null);
  if (!flate || !flate.unzipSync) throw new Error("fflate není k dispozici");
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const files = flate.unzipSync(u8);
  const contentKey = Object.keys(files).find(k => k.replace(/\\/g, "/").toLowerCase() === "content.xml");
  const content = contentKey ? files[contentKey] : null;
  if (!content) throw new Error("Neplatný ODT: chybí content.xml");
  const dec = new TextDecoder("utf-8");
  const stylesKey = Object.keys(files).find(k => k.replace(/\\/g, "/").toLowerCase() === "styles.xml");
  const paragraphs = [];
  if (stylesKey && files[stylesKey]) {
    try {
      paragraphs.push(...parseOdtXmlPart(dec.decode(files[stylesKey])));
    } catch (_) {}
  }
  paragraphs.push(...parseOdtXmlPart(dec.decode(content)));
  return paragraphs.join("\n\n");
}

