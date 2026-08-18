// 文本类格式互转（Node + 浏览器通用，零依赖）。
// 桌面版靠 csv-parse / marked / turndown 完成同类工作；离线单文件版不能带 node_modules，
// 因此这里按 text-conversion.js 的既有契约重写：严格 CSV 语法、ATX 标题、fenced 代码块、
// 表格转义规则、链接/图片白名单、以及同样的错误码（CSV_PARSE_FAILED 等）。
(function (global, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    global.FMOffline = global.FMOffline || {};
    global.FMOffline.textFormats = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const FORBIDDEN_HEADERS = new Set(["__proto__", "prototype", "constructor"]);

  function csvError(message, cause) {
    const error = new Error(`CSV 解析失败：${message}`);
    error.code = "CSV_PARSE_FAILED";
    if (cause) error.cause = cause;
    return error;
  }

  function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  // 严格 CSV：引号内允许换行（原样保留 CRLF），"" 表示字面量引号，行列数必须一致，空行跳过。
  function parseCsvRecords(input, options = {}) {
    const delimiter = options.delimiter || ",";
    if (delimiter.length !== 1) throw csvError("分隔符必须是单个字符。");
    const text = stripBom(String(input == null ? "" : input));
    const records = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let fieldStarted = false;
    let index = 0;

    const endField = () => {
      row.push(field);
      field = "";
      fieldStarted = false;
    };
    const endRow = () => {
      endField();
      const isBlank = row.length === 1 && row[0] === "";
      if (!isBlank) records.push(row);
      row = [];
    };

    while (index < text.length) {
      const char = text[index];
      if (inQuotes) {
        if (char === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 2;
            continue;
          }
          inQuotes = false;
          index += 1;
          continue;
        }
        field += char;
        index += 1;
        continue;
      }
      if (char === '"') {
        if (fieldStarted && field.length > 0) throw csvError("引号必须出现在字段开头。");
        inQuotes = true;
        fieldStarted = true;
        index += 1;
        continue;
      }
      if (char === delimiter) {
        endField();
        index += 1;
        continue;
      }
      if (char === "\r" && text[index + 1] === "\n") {
        endRow();
        index += 2;
        continue;
      }
      if (char === "\n" || char === "\r") {
        endRow();
        index += 1;
        continue;
      }
      field += char;
      fieldStarted = true;
      index += 1;
    }

    if (inQuotes) throw csvError("引号未闭合。");
    if (field.length > 0 || row.length > 0) endRow();

    if (records.length > 0) {
      const width = records[0].length;
      for (const record of records) {
        if (record.length !== width) throw csvError(`列数不一致：期望 ${width} 列，实际 ${record.length} 列。`);
      }
    }
    return records;
  }

  function buildHeaders(headerRow) {
    const seen = new Set();
    return headerRow.map((raw, index) => {
      const header = String(raw || `column_${index + 1}`);
      const lower = header.toLowerCase();
      if (seen.has(lower)) throw csvError(`表头重复：${header}`);
      if (FORBIDDEN_HEADERS.has(lower)) throw csvError(`表头不安全：${header}`);
      seen.add(lower);
      return header;
    });
  }

  function csvToJsonObjects(input, options = {}) {
    const records = parseCsvRecords(input, options);
    if (records.length === 0) return [];
    const headers = buildHeaders(records[0]);
    return records.slice(1).map((record) => {
      const row = {};
      headers.forEach((header, index) => {
        row[header] = record[index] == null ? "" : record[index];
      });
      return row;
    });
  }

  function escapeMarkdownCell(value) {
    return String(value == null ? "" : value)
      .split("\\")
      .join("\\\\")
      .split("|")
      .join("\\|")
      .split("\r\n")
      .join("\n")
      .split("\n")
      .join("<br>");
  }

  function rowsToMarkdownTable(records) {
    if (records.length === 0) return "";
    const width = records.reduce((max, record) => Math.max(max, record.length), 0);
    const lines = [];
    records.forEach((record, index) => {
      const cells = [];
      for (let i = 0; i < width; i += 1) cells.push(escapeMarkdownCell(record[i] == null ? "" : record[i]));
      lines.push(`| ${cells.join(" | ")} |`);
      if (index === 0) lines.push(`| ${new Array(width).fill("---").join(" | ")} |`);
    });
    return lines.join("\n");
  }

  function csvToMarkdown(input, options = {}) {
    return rowsToMarkdownTable(parseCsvRecords(input, options));
  }

  function escapeHtmlText(value) {
    return String(value == null ? "" : value)
      .split("&")
      .join("&amp;")
      .split("<")
      .join("&lt;")
      .split(">")
      .join("&gt;");
  }

  function escapeHtmlAttribute(value) {
    return escapeHtmlText(value).split('"').join("&quot;");
  }

  const HTML_TABLE_STYLE = 'body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:24px}'
    + "table{border-collapse:collapse;width:100%}"
    + "th,td{border:1px solid #999;padding:6px 10px;text-align:left;vertical-align:top}"
    + "tr:first-child{font-weight:bold;background:#f5f5f5}";

  function csvToHtmlTable(input, options = {}) {
    const records = parseCsvRecords(input, options);
    if (records.length === 0) return "<p>（空 CSV）</p>";
    const width = records.reduce((max, record) => Math.max(max, record.length), 0);
    const rows = records.map((record) => {
      const cells = [];
      for (let i = 0; i < width; i += 1) cells.push(`<td>${escapeHtmlText(record[i] == null ? "" : record[i])}</td>`);
      return `<tr>${cells.join("")}</tr>`;
    });
    return `<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><title>Converted table</title>`
      + `<style>${HTML_TABLE_STYLE}</style></head>\n<body>\n<table>\n${rows.join("\n")}\n</table>\n</body>\n</html>`;
  }

  // JSON -> CSV：键路径扁平化 + 排序，所有字段都加引号（与桌面版 jsonToCsv 保持一致）
  function stableJsonStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
    if (value && typeof value === "object") {
      const keys = Object.keys(value).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  function flattenRow(row, prefix, target) {
    const keys = Object.keys(row).sort();
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const value = row[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (Object.prototype.hasOwnProperty.call(target, path)) {
          const error = new Error(`JSON 转 CSV 失败：字段路径冲突：${path}`);
          error.code = "JSON_CSV_PATH_COLLISION";
          error.path = path;
          throw error;
        }
        flattenRow(value, path, target);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(target, path)) {
        const error = new Error(`JSON 转 CSV 失败：字段路径冲突：${path}`);
        error.code = "JSON_CSV_PATH_COLLISION";
        error.path = path;
        throw error;
      }
      target[path] = Array.isArray(value) ? stableJsonStringify(value) : value;
    }
    return target;
  }

  function quoteCsvField(value) {
    if (value == null) return '""';
    return `"${String(value).split('"').join('""')}"`;
  }

  function jsonToCsv(jsonText) {
    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (error) {
      const wrapped = new Error("JSON 解析失败：文件内容不是有效的 JSON。");
      wrapped.code = "JSON_PARSE_FAILED";
      wrapped.cause = error;
      throw wrapped;
    }
    const rows = Array.isArray(data) ? data : [data];
    const flattened = rows.map((row) => {
      if (row && typeof row === "object" && !Array.isArray(row)) return flattenRow(row, "", {});
      return { value: Array.isArray(row) ? stableJsonStringify(row) : row };
    });
    const headers = [...new Set(flattened.flatMap((row) => Object.keys(row)))].sort();
    const lines = [headers.map(quoteCsvField).join(",")];
    for (const row of flattened) {
      lines.push(headers.map((header) => quoteCsvField(row[header] == null ? "" : row[header])).join(","));
    }
    return lines.join("\n");
  }

  function serializeCsv(records, options = {}) {
    const delimiter = options.delimiter || ",";
    const body = records
      .map((record) => record.map((field) => quoteCsvField(field)).join(delimiter))
      .join("\n");
    return options.bom ? `\uFEFF${body}` : body;
  }

  // ---------- 极简 HTML 解析（供 html -> md / txt 使用） ----------

  const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const RAW_TEXT_TAGS = new Set(["script", "style"]);
  const BLOCK_TAGS = new Set(["p", "div", "section", "article", "header", "footer", "main", "aside", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "hr"]);
  const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

  function decodeHtmlEntities(text) {
    return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
      if (body[0] === "#") {
        const isHex = body[1] === "x" || body[1] === "X";
        const point = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
        if (!Number.isFinite(point) || point < 0 || point > 0x10ffff) return match;
        try {
          return String.fromCodePoint(point);
        } catch (error) {
          return match;
        }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? match : named;
    });
  }

  function parseAttributes(source) {
    const attributes = {};
    const pattern = /([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let match = pattern.exec(source);
    while (match) {
      const name = match[1].toLowerCase();
      const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : "";
      attributes[name] = decodeHtmlEntities(value);
      match = pattern.exec(source);
    }
    return attributes;
  }

  function parseHtml(html) {
    const root = { type: "root", children: [] };
    const stack = [root];
    const text = String(html == null ? "" : html);
    let index = 0;
    const top = () => stack[stack.length - 1];
    const pushText = (value) => {
      if (!value) return;
      top().children.push({ type: "text", value: decodeHtmlEntities(value) });
    };
    const closeTag = (tag) => {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.length = i;
          return;
        }
      }
    };

    while (index < text.length) {
      const next = text.indexOf("<", index);
      if (next === -1) {
        pushText(text.slice(index));
        break;
      }
      pushText(text.slice(index, next));
      if (text.startsWith("<!--", next)) {
        const end = text.indexOf("-->", next + 4);
        index = end === -1 ? text.length : end + 3;
        continue;
      }
      if (text.startsWith("<!", next) || text.startsWith("<?", next)) {
        const end = text.indexOf(">", next);
        index = end === -1 ? text.length : end + 1;
        continue;
      }
      const closeMatch = /^<\/\s*([a-zA-Z][\w:-]*)\s*>/.exec(text.slice(next));
      if (closeMatch) {
        closeTag(closeMatch[1].toLowerCase());
        index = next + closeMatch[0].length;
        continue;
      }
      const openMatch = /^<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(text.slice(next));
      if (!openMatch) {
        pushText("<");
        index = next + 1;
        continue;
      }
      const tag = openMatch[1].toLowerCase();
      const node = { type: "element", tag, attributes: parseAttributes(openMatch[2]), children: [] };
      // 隐式闭合：<li> 遇 <li>、<p> 遇块级元素、<td>/<th>/<tr> 同级
      const current = top();
      if (current.type === "element") {
        if (tag === "li" && current.tag === "li") stack.pop();
        else if ((tag === "td" || tag === "th") && (current.tag === "td" || current.tag === "th")) stack.pop();
        else if (tag === "tr" && (current.tag === "td" || current.tag === "th")) {
          stack.pop();
          if (top().type === "element" && top().tag === "tr") stack.pop();
        } else if (tag === "tr" && current.tag === "tr") stack.pop();
        else if (current.tag === "p" && BLOCK_TAGS.has(tag)) stack.pop();
      }
      top().children.push(node);
      index = next + openMatch[0].length;

      if (RAW_TEXT_TAGS.has(tag)) {
        const closing = new RegExp(`</${tag}\\s*>`, "i");
        const rest = text.slice(index);
        const match = closing.exec(rest);
        const raw = match ? rest.slice(0, match.index) : rest;
        node.children.push({ type: "text", value: raw });
        index += match ? match.index + match[0].length : rest.length;
        continue;
      }
      if (!VOID_TAGS.has(tag) && !openMatch[3]) stack.push(node);
    }
    return root;
  }

  function collectText(node) {
    if (node.type === "text") return node.value;
    if (node.type === "element" && RAW_TEXT_TAGS.has(node.tag)) return "";
    return (node.children || []).map(collectText).join("");
  }

  // ---------- HTML -> Markdown ----------

  const SAFE_TABLE_TAGS = new Set(["table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "strong", "b", "em", "i", "code", "br", "p", "ul", "ol", "li"]);
  const DROP_TAGS = new Set(["script", "style", "iframe", "object", "embed"]);

  function findElements(node, tag, result = []) {
    for (const child of node.children || []) {
      if (child.type !== "element") continue;
      if (child.tag === tag) result.push(child);
      findElements(child, tag, result);
    }
    return result;
  }

  function isComplexTable(table) {
    if (findElements(table, "table").length > 0) return true;
    const cells = [...findElements(table, "th"), ...findElements(table, "td")];
    return cells.some((cell) => "rowspan" in cell.attributes || "colspan" in cell.attributes);
  }

  function serializeSafeTable(node) {
    if (node.type === "text") return escapeHtmlText(node.value);
    if (node.type !== "element") return "";
    if (DROP_TAGS.has(node.tag)) return "";
    const inner = (node.children || []).map(serializeSafeTable).join("");
    if (!SAFE_TABLE_TAGS.has(node.tag)) return inner;
    if (node.tag === "br") return "<br>";
    let attributes = "";
    if (node.tag === "th" || node.tag === "td") {
      for (const name of ["rowspan", "colspan"]) {
        const value = node.attributes[name];
        if (value !== undefined && /^[1-9]\d*$/.test(String(value))) attributes += ` ${name}="${value}"`;
      }
    }
    return `<${node.tag}${attributes}>${inner}</${node.tag}>`;
  }

  function markdownTableCell(cell) {
    const inline = inlineMarkdown(cell.children || [])
      .trim()
      .split("\\")
      .join("\\\\")
      .split("|")
      .join("\\|");
    return inline.replace(/(?:\s*\n\s*)+/g, "<br>");
  }

  function tableToMarkdown(table) {
    if (isComplexTable(table)) return `\n\n${serializeSafeTable(table)}\n\n`;
    const rows = findElements(table, "tr")
      .map((row) => (row.children || []).filter((child) => child.type === "element" && (child.tag === "td" || child.tag === "th")))
      .filter((cells) => cells.length > 0);
    if (rows.length === 0) return "";
    const width = rows.reduce((max, cells) => Math.max(max, cells.length), 0);
    const lines = [];
    rows.forEach((cells, index) => {
      const values = [];
      for (let i = 0; i < width; i += 1) values.push(cells[i] ? markdownTableCell(cells[i]) : "");
      lines.push(`| ${values.join(" | ")} |`);
      if (index === 0) lines.push(`| ${new Array(width).fill("---").join(" | ")} |`);
    });
    return `\n\n${lines.join("\n")}\n\n`;
  }

  function inlineMarkdown(nodes) {
    let out = "";
    for (const node of nodes) {
      if (node.type === "text") {
        out += node.value.replace(/\s+/g, " ");
        continue;
      }
      if (node.type !== "element") continue;
      const tag = node.tag;
      if (DROP_TAGS.has(tag)) continue;
      const inner = inlineMarkdown(node.children || []);
      if (tag === "br") out += "\n";
      else if (tag === "strong" || tag === "b") out += `**${inner.trim()}**`;
      else if (tag === "em" || tag === "i") out += `*${inner.trim()}*`;
      else if (tag === "code") out += `\`${inner.trim()}\``;
      else if (tag === "a") {
        const href = node.attributes.href || "";
        out += href ? `[${inner.trim()}](${href})` : inner;
      } else if (tag === "img") {
        const src = node.attributes.src || "";
        const alt = node.attributes.alt || "";
        out += src ? `![${alt}](${src})` : alt;
      } else if (tag === "p" || BLOCK_TAGS.has(tag)) out += `\n${blockMarkdown([node])}\n`;
      else out += inner;
    }
    return out;
  }

  function listMarkdown(node, ordered) {
    const items = (node.children || []).filter((child) => child.type === "element" && child.tag === "li");
    return items
      .map((item, index) => {
        const marker = ordered ? `${index + 1}.` : "*";
        const content = blockMarkdown(item.children || []).trim() || inlineMarkdown(item.children || []).trim();
        const [first, ...rest] = content.split("\n");
        const indented = rest.map((line) => (line ? `    ${line}` : line)).join("\n");
        return rest.length > 0 ? `${marker} ${first}\n${indented}` : `${marker} ${first}`;
      })
      .join("\n");
  }

  function blockMarkdown(nodes) {
    const blocks = [];
    let inlineBuffer = [];
    const flushInline = () => {
      if (inlineBuffer.length === 0) return;
      const text = inlineMarkdown(inlineBuffer).replace(/[ \t]+/g, " ").trim();
      if (text) blocks.push(text);
      inlineBuffer = [];
    };

    for (const node of nodes) {
      if (node.type === "text") {
        inlineBuffer.push(node);
        continue;
      }
      if (node.type !== "element") continue;
      const tag = node.tag;
      if (DROP_TAGS.has(tag) || tag === "head" || tag === "title" || tag === "meta" || tag === "link") continue;
      if (/^h[1-6]$/.test(tag)) {
        flushInline();
        const level = Number(tag[1]);
        blocks.push(`${"#".repeat(level)} ${inlineMarkdown(node.children || []).trim()}`);
        continue;
      }
      if (tag === "pre") {
        flushInline();
        const codeNode = (node.children || []).find((child) => child.type === "element" && child.tag === "code");
        const language = codeNode ? String(codeNode.attributes.class || "").replace(/^language-/, "") : "";
        const code = collectText(node).replace(/\n$/, "");
        blocks.push(`\`\`\`${language}\n${code}\n\`\`\``);
        continue;
      }
      if (tag === "table") {
        flushInline();
        const markdown = tableToMarkdown(node).trim();
        if (markdown) blocks.push(markdown);
        continue;
      }
      if (tag === "ul" || tag === "ol") {
        flushInline();
        const markdown = listMarkdown(node, tag === "ol");
        if (markdown) blocks.push(markdown);
        continue;
      }
      if (tag === "blockquote") {
        flushInline();
        const inner = blockMarkdown(node.children || []).trim();
        if (inner) blocks.push(inner.split("\n").map((line) => `> ${line}`).join("\n"));
        continue;
      }
      if (tag === "hr") {
        flushInline();
        blocks.push("---");
        continue;
      }
      if (tag === "br") {
        inlineBuffer.push(node);
        continue;
      }
      if (BLOCK_TAGS.has(tag) || tag === "html" || tag === "body") {
        flushInline();
        const inner = blockMarkdown(node.children || []).trim();
        if (inner) blocks.push(inner);
        continue;
      }
      inlineBuffer.push(node);
    }
    flushInline();
    return blocks.join("\n\n");
  }

  function htmlToMarkdown(html) {
    return blockMarkdown(parseHtml(html).children).replace(/\n{3,}/g, "\n\n").trim();
  }

  function htmlToText(html) {
    const tree = parseHtml(html);
    const markdownish = blockMarkdown(tree.children);
    return markdownish
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\*\s+/gm, "- ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ---------- Markdown -> HTML ----------

  function isSafeMarkdownLink(href) {
    const value = String(href || "").trim();
    if (!value) return false;
    if (/^(?:https?:|mailto:)/i.test(value)) return true;
    return /^(?:#|\/|\.\/|\.\.\/)/.test(value);
  }

  function isSafeMarkdownImage(src) {
    const value = String(src || "").trim();
    if (!value) return false;
    if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
    if (value.startsWith("//")) return false;
    if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(value)) return true;
    return !/^[a-z][a-z\d+.-]*:/i.test(value);
  }

  function inlineHtml(text) {
    let out = "";
    let index = 0;
    const source = String(text);
    while (index < source.length) {
      const char = source[index];
      if (char === "`") {
        const end = source.indexOf("`", index + 1);
        if (end > index) {
          out += `<code>${escapeHtmlText(source.slice(index + 1, end))}</code>`;
          index = end + 1;
          continue;
        }
      }
      if (char === "!" && source[index + 1] === "[") {
        const match = /^!\[([^\]]*)\]\(((?:[^()\s]|\([^()]*\))*)(?:\s+"([^"]*)")?\)/.exec(source.slice(index));
        if (match) {
          const [full, alt, src, title] = match;
          if (isSafeMarkdownImage(src)) {
            const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
            out += `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}"${titleAttribute}>`;
          } else {
            out += escapeHtmlText(alt);
          }
          index += full.length;
          continue;
        }
      }
      if (char === "[") {
        const match = /^\[([^\]]*)\]\(((?:[^()\s]|\([^()]*\))*)(?:\s+"([^"]*)")?\)/.exec(source.slice(index));
        if (match) {
          const [full, label, href, title] = match;
          if (isSafeMarkdownLink(href)) {
            const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
            out += `<a href="${escapeHtmlAttribute(href)}"${titleAttribute}>${inlineHtml(label)}</a>`;
          } else {
            out += escapeHtmlText(label);
          }
          index += full.length;
          continue;
        }
      }
      if (source.startsWith("**", index)) {
        const end = source.indexOf("**", index + 2);
        if (end > index + 1) {
          out += `<strong>${inlineHtml(source.slice(index + 2, end))}</strong>`;
          index = end + 2;
          continue;
        }
      }
      if (char === "*" || char === "_") {
        const end = source.indexOf(char, index + 1);
        if (end > index + 1) {
          out += `<em>${inlineHtml(source.slice(index + 1, end))}</em>`;
          index = end + 1;
          continue;
        }
      }
      out += escapeHtmlText(char);
      index += 1;
    }
    return out;
  }

  function markdownBlocksToHtml(markdown) {
    const lines = String(markdown == null ? "" : markdown).replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let paragraph = [];
    let listType = null;
    let listItems = [];
    let codeLines = null;
    let codeLanguage = "";
    let quoteLines = null;

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      html.push(`<p>${inlineHtml(paragraph.join(" ").trim())}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!listType) return;
      const items = listItems.map((item) => `<li>${inlineHtml(item)}</li>`).join("\n");
      html.push(`<${listType}>\n${items}\n</${listType}>`);
      listType = null;
      listItems = [];
    };
    const flushQuote = () => {
      if (!quoteLines) return;
      html.push(`<blockquote><p>${inlineHtml(quoteLines.join(" ").trim())}</p></blockquote>`);
      quoteLines = null;
    };
    const flushAll = () => {
      flushParagraph();
      flushList();
      flushQuote();
    };

    for (const line of lines) {
      const fence = /^```(.*)$/.exec(line.trim());
      if (codeLines) {
        if (fence) {
          html.push(`<pre><code${codeLanguage ? ` class="language-${escapeHtmlAttribute(codeLanguage)}"` : ""}>${escapeHtmlText(codeLines.join("\n"))}\n</code></pre>`);
          codeLines = null;
          codeLanguage = "";
          continue;
        }
        codeLines.push(line);
        continue;
      }
      if (fence) {
        flushAll();
        codeLines = [];
        codeLanguage = fence[1].trim();
        continue;
      }
      if (!line.trim()) {
        flushAll();
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushAll();
        const level = heading[1].length;
        html.push(`<h${level}>${inlineHtml(heading[2].trim())}</h${level}>`);
        continue;
      }
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        flushAll();
        html.push("<hr>");
        continue;
      }
      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph();
        flushList();
        quoteLines = quoteLines || [];
        quoteLines.push(quote[1]);
        continue;
      }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || ordered) {
        flushParagraph();
        flushQuote();
        const type = bullet ? "ul" : "ol";
        if (listType && listType !== type) flushList();
        listType = type;
        listItems.push((bullet ? bullet[1] : ordered[1]).trim());
        continue;
      }
      flushList();
      flushQuote();
      paragraph.push(line.trim());
    }
    if (codeLines) {
      html.push(`<pre><code${codeLanguage ? ` class="language-${escapeHtmlAttribute(codeLanguage)}"` : ""}>${escapeHtmlText(codeLines.join("\n"))}\n</code></pre>`);
    }
    flushAll();
    return html.join("\n");
  }

  function wrapHtmlDocument(body, title) {
    return `<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><title>${escapeHtmlText(title)}</title></head>\n<body>\n${body.trim()}\n</body>\n</html>`;
  }

  function markdownToHtml(markdown) {
    return wrapHtmlDocument(markdownBlocksToHtml(markdown), "Converted document");
  }

  function textToHtml(raw) {
    return `<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><title>Converted text</title></head>\n`
      + `<body><pre>${escapeHtmlAttribute(raw)}</pre></body>\n</html>`;
  }

  function jsonPretty(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      const wrapped = new Error("JSON 解析失败：文件内容不是有效的 JSON。");
      wrapped.code = "JSON_PARSE_FAILED";
      wrapped.cause = error;
      throw wrapped;
    }
    return JSON.stringify(data, null, 2);
  }

  function textToCsvLines(raw) {
    return String(raw)
      .split(/\r?\n/)
      .map((line) => quoteCsvField(line))
      .join("\n");
  }

  return {
    parseCsvRecords,
    csvToJsonObjects,
    csvToMarkdown,
    csvToHtmlTable,
    rowsToMarkdownTable,
    jsonToCsv,
    serializeCsv,
    quoteCsvField,
    stableJsonStringify,
    parseHtml,
    htmlToMarkdown,
    htmlToText,
    markdownToHtml,
    markdownBlocksToHtml,
    textToHtml,
    textToCsvLines,
    jsonPretty,
    escapeHtmlText,
    escapeHtmlAttribute,
    decodeHtmlEntities,
    isSafeMarkdownLink,
    isSafeMarkdownImage,
    collectText,
  };
});
