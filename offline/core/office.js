// 最小 DOCX（Office Open XML）生成（Node + 浏览器通用）。
// 只覆盖离线版需要的结构：标题、段落、无序/有序列表（以字符标记呈现）、表格。
// 复杂版式（图片、页眉页脚、样式继承）仍属桌面版 LibreOffice 引擎的范围。
(function (global, factory) {
  const api = factory(typeof require === "function" ? require : null);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    global.FMOffline = global.FMOffline || {};
    global.FMOffline.office = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (nodeRequire) {
  function zipWriter() {
    if (nodeRequire) return nodeRequire("./zip-writer.js");
    return globalThis.FMOffline.zipWriter;
  }

  function textFormats() {
    if (nodeRequire) return nodeRequire("./text-formats.js");
    return globalThis.FMOffline.textFormats;
  }

  function escapeXml(text) {
    return String(text == null ? "" : text)
      .split("&")
      .join("&amp;")
      .split("<")
      .join("&lt;")
      .split(">")
      .join("&gt;")
      .split('"')
      .join("&quot;");
  }

  const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + "</Types>";

  const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + "</Relationships>";

  const DOCUMENT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + "</Relationships>";

  function headingStyle(level, size) {
    return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>`
      + `<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${level - 1}"/>`
      + `<w:spacing w:before="240" w:after="120"/></w:pPr>`
      + `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  }

  const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>'
    + '<w:rPr><w:sz w:val="22"/></w:rPr></w:style>'
    + [44, 36, 30, 26, 24, 22].map((size, index) => headingStyle(index + 1, size)).join("")
    + "</w:styles>";

  // rPr 必须写在每个 <w:r> 里：只放在 <w:pPr> 中只会影响段落标记，正文仍是默认字体
  function runs(text, runProperties) {
    const lines = String(text == null ? "" : text).split("\n");
    const rPr = runProperties || "";
    return lines
      .map((line, index) => (index === 0 ? "" : `<w:r>${rPr}<w:br/></w:r>`)
        + `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`)
      .join("");
  }

  const MONO_RPR = '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr>';

  function paragraph(text, options = {}) {
    const properties = [];
    if (options.style) properties.push(`<w:pStyle w:val="${options.style}"/>`);
    if (options.indent) properties.push(`<w:ind w:left="${options.indent}"/>`);
    if (options.mono) properties.push(MONO_RPR);
    const pPr = properties.length > 0 ? `<w:pPr>${properties.join("")}</w:pPr>` : "";
    return `<w:p>${pPr}${runs(text, options.mono ? MONO_RPR : "")}</w:p>`;
  }

  function tableXml(rows) {
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const grid = `<w:tblGrid>${new Array(width).fill('<w:gridCol w:w="2400"/>').join("")}</w:tblGrid>`;
    const borders = '<w:tblBorders><w:top w:val="single" w:sz="6" w:color="999999"/>'
      + '<w:left w:val="single" w:sz="6" w:color="999999"/><w:bottom w:val="single" w:sz="6" w:color="999999"/>'
      + '<w:right w:val="single" w:sz="6" w:color="999999"/><w:insideH w:val="single" w:sz="6" w:color="999999"/>'
      + '<w:insideV w:val="single" w:sz="6" w:color="999999"/></w:tblBorders>';
    const body = rows
      .map((row) => {
        const cells = [];
        for (let i = 0; i < width; i += 1) {
          cells.push(`<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${paragraph(row[i] == null ? "" : row[i])}</w:tc>`);
        }
        return `<w:tr>${cells.join("")}</w:tr>`;
      })
      .join("");
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${grid}${body}</w:tbl>`;
  }

  // blocks: [{ type: 'heading'|'paragraph'|'bullet'|'ordered'|'code'|'table', text?, level?, index?, rows? }]
  function blocksToDocumentXml(blocks) {
    const body = blocks
      .map((block) => {
        if (block.type === "heading") return paragraph(block.text, { style: `Heading${Math.min(6, Math.max(1, block.level || 1))}` });
        if (block.type === "bullet") return paragraph(`• ${block.text}`, { indent: 360 });
        if (block.type === "ordered") return paragraph(`${block.index || 1}. ${block.text}`, { indent: 360 });
        if (block.type === "code") return paragraph(block.text, { mono: true, indent: 240 });
        // 表格后必须再跟一个空段落：Word 自己的写法如此，紧跟 sectPr 的表格在部分版本里会报错
        if (block.type === "table") return `${tableXml(block.rows || [])}<w:p/>`;
        return paragraph(block.text);
      })
      .join("");
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>`
      + '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>';
  }

  // Markdown / 纯文本 -> 块模型
  function textToBlocks(raw, source) {
    const text = String(raw == null ? "" : raw).replace(/\r\n/g, "\n");
    if (source !== "md" && source !== "markdown") {
      return text
        .split(/\n\s*\n/)
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => ({ type: "paragraph", text: chunk }));
    }
    const blocks = [];
    const formats = textFormats();
    const lines = text.split("\n");
    let codeLines = null;
    let orderedIndex = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const trimmed = line.trim();
      // GFM 表格转成真正的 DOCX 表格，而不是一行竖线文本
      if (!codeLines && formats && formats.isTableRow(line) && formats.isTableDelimiterRow(lines[lineIndex + 1])) {
        const rows = [formats.splitTableRow(line)];
        let cursor = lineIndex + 2;
        while (cursor < lines.length && formats.isTableRow(lines[cursor])) {
          rows.push(formats.splitTableRow(lines[cursor]));
          cursor += 1;
        }
        blocks.push({ type: "table", rows });
        lineIndex = cursor - 1;
        continue;
      }
      if (/^```/.test(trimmed)) {
        if (codeLines) {
          blocks.push({ type: "code", text: codeLines.join("\n") });
          codeLines = null;
        } else {
          codeLines = [];
        }
        continue;
      }
      if (codeLines) {
        codeLines.push(line);
        continue;
      }
      if (!trimmed) {
        orderedIndex = 0;
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading) {
        blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
        continue;
      }
      const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
      if (bullet) {
        blocks.push({ type: "bullet", text: bullet[1].trim() });
        continue;
      }
      const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
      if (ordered) {
        orderedIndex += 1;
        blocks.push({ type: "ordered", index: orderedIndex, text: ordered[2].trim() });
        continue;
      }
      const previous = blocks[blocks.length - 1];
      if (previous && previous.type === "paragraph") previous.text = `${previous.text}\n${trimmed}`;
      else blocks.push({ type: "paragraph", text: trimmed });
    }
    if (codeLines) blocks.push({ type: "code", text: codeLines.join("\n") });
    return blocks;
  }

  async function createDocx(blocks) {
    const zip = zipWriter();
    return zip.createZipCompressed([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: ROOT_RELS },
      { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS },
      { name: "word/document.xml", data: blocksToDocumentXml(blocks) },
      { name: "word/styles.xml", data: STYLES },
    ]);
  }

  return { createDocx, blocksToDocumentXml, textToBlocks, tableXml, paragraph };
});
