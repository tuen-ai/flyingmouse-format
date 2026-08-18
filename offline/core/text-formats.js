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
    let rowHasContent = false;
    const endRow = () => {
      endField();
      // 只丢真正的空行；显式写出的 "" 是一行合法数据
      const isBlankLine = row.length === 1 && row[0] === "" && !rowHasContent;
      if (!isBlankLine) records.push(row);
      row = [];
      rowHasContent = false;
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
        rowHasContent = true;
        index += 1;
        continue;
      }
      if (char === delimiter) {
        endField();
        rowHasContent = true;
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
      rowHasContent = true;
      index += 1;
    }

    if (inQuotes) throw csvError("引号未闭合。");
    if (field.length > 0 || row.length > 0 || rowHasContent) endRow();

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
      const row = Object.create(null);
      headers.forEach((header, index) => {
        row[header] = record[index] == null ? "" : record[index];
      });
      // 与 xml-json.js 一样用 JSON 往返抹平 null 原型，避免下游 deepStrictEqual / 序列化出现差异
      return JSON.parse(JSON.stringify(row));
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

  // target 用 null 原型：源 JSON 里的 "__proto__" 字段用普通对象会触发原型 setter，整列被悄悄丢掉
  const MAX_JSON_DEPTH = 256;

  function flattenRow(row, prefix, target, depth = 0) {
    if (depth > MAX_JSON_DEPTH) {
      const error = new Error(`JSON 转 CSV 失败：嵌套层级超过 ${MAX_JSON_DEPTH}。`);
      error.code = "JSON_TOO_DEEP";
      throw error;
    }
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
        flattenRow(value, path, target, depth + 1);
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
      if (row && typeof row === "object" && !Array.isArray(row)) return flattenRow(row, "", Object.create(null));
      const fallback = Object.create(null);
      fallback.value = Array.isArray(row) ? stableJsonStringify(row) : row;
      return fallback;
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
  // null 原型：否则 "&constructor;" 之类的实体会命中 Object.prototype 上的成员
  const NAMED_ENTITIES = Object.assign(Object.create(null), { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " });
  // 嵌套深度上限：畸形/恶意 HTML（几万层嵌套）会让后续递归序列化爆栈，超过这个深度就压平
  const MAX_HTML_DEPTH = 256;
  // 这些标签可以被后面的同级标签隐式关掉（HTML 解析器的 optional end tag 子集）
  const IMPLICIT_CLOSABLE = new Set(["p", "li", "td", "th", "tr", "span", "em", "strong", "b", "i", "code", "a"]);

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
      // 隐式闭合：<li> 遇 <li>、<td>/<th>/<tr> 同级、<p> 遇块级元素。
      // 必须沿栈往下找（真实 HTML 里常见 <li><p>a<li>b，只看直接父节点会把第二个 li 塞进第一个里）。
      const closeImplicit = (targets) => {
        for (let i = stack.length - 1; i > 0; i -= 1) {
          const node = stack[i];
          if (targets.includes(node.tag)) {
            stack.length = i;
            return;
          }
          if (!IMPLICIT_CLOSABLE.has(node.tag)) return;
        }
      };
      if (tag === "li") closeImplicit(["li"]);
      else if (tag === "td" || tag === "th") closeImplicit(["td", "th"]);
      else if (tag === "tr") closeImplicit(["tr"]);
      else if (BLOCK_TAGS.has(tag) && top().type === "element" && top().tag === "p") stack.pop();
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
      if (!VOID_TAGS.has(tag) && !openMatch[3] && stack.length < MAX_HTML_DEPTH) stack.push(node);
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
        out += isSafeMarkdownLink(href) ? `[${inner.trim()}](${href})` : inner;
      } else if (tag === "img") {
        const src = node.attributes.src || "";
        const alt = node.attributes.alt || "";
        out += isSafeMarkdownImage(src) ? `![${alt}](${src})` : alt;
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
    // 控制字符会被浏览器忽略，可用来伪装 javascript:；// 开头是协议相对地址（Windows 上还会变成 UNC 路径）
    if (/[\u0000-\u001f\u007f]/.test(value)) return false;
    if (value.startsWith("//")) return false;
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

  const MARKDOWN_ESCAPABLE = "\\`*_{}[]()#+-.!>|~";

  // 找强调的收尾定界符：闭合符前面不能是空白（CommonMark 的 right-flanking 近似）
  function findEmphasisEnd(source, start, marker) {
    let index = source.indexOf(marker, start);
    while (index > start) {
      const previous = source[index - 1];
      if (previous && !/\s/.test(previous) && previous !== "\\") return index;
      index = source.indexOf(marker, index + marker.length);
    }
    return -1;
  }

  // 只有附近确实存在 "](" 时才跑链接正则：满屏 "[" 的输入否则会退化成 O(n^2)
  function hasLinkTail(source, index) {
    const close = source.indexOf("](", index + 1);
    return close !== -1 && close - index <= 1024;
  }

  function isWordCharacter(char) {
    return Boolean(char) && /[0-9A-Za-z\u4e00-\u9fff]/.test(char);
  }

  function inlineHtml(text) {
    let out = "";
    let index = 0;
    const source = String(text);
    while (index < source.length) {
      const char = source[index];
      if (char === "\\" && MARKDOWN_ESCAPABLE.includes(source[index + 1] || "")) {
        out += escapeHtmlText(source[index + 1]);
        index += 2;
        continue;
      }
      if (char === "`") {
        const end = source.indexOf("`", index + 1);
        if (end > index) {
          out += `<code>${escapeHtmlText(source.slice(index + 1, end))}</code>`;
          index = end + 1;
          continue;
        }
      }
      if (char === "!" && source[index + 1] === "[" && hasLinkTail(source, index)) {
        const match = /^!\[([^\]]{0,1024})\]\(((?:[^()\s]|\([^()]*\)){0,2048})(?:\s+"([^"]{0,256})")?\)/.exec(source.slice(index));
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
      if (char === "[" && hasLinkTail(source, index)) {
        const match = /^\[([^\]]{0,1024})\]\(((?:[^()\s]|\([^()]*\)){0,2048})(?:\s+"([^"]{0,256})")?\)/.exec(source.slice(index));
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
      if (source.startsWith("**", index) && !/\s/.test(source[index + 2] || " ")) {
        const end = findEmphasisEnd(source, index + 2, "**");
        if (end > index + 1) {
          out += `<strong>${inlineHtml(source.slice(index + 2, end))}</strong>`;
          index = end + 2;
          continue;
        }
      }
      if (char === "*" || char === "_") {
        // 下划线不参与词内强调（snake_case_name 必须原样保留）；星号也要求定界符紧挨非空白
        const intraWord = char === "_" && (isWordCharacter(source[index - 1]) || false);
        if (!intraWord && !/\s/.test(source[index + 1] || " ")) {
          const end = findEmphasisEnd(source, index + 1, char);
          if (end > index + 1 && !(char === "_" && isWordCharacter(source[end + 1]))) {
            out += `<em>${inlineHtml(source.slice(index + 1, end))}</em>`;
            index = end + 1;
            continue;
          }
        }
      }
      out += escapeHtmlText(char);
      index += 1;
    }
    return out;
  }

  // ---------- GFM 表格 ----------

  function splitTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let current = "";
    for (let i = 0; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (char === "\\" && (trimmed[i + 1] === "|" || trimmed[i + 1] === "\\")) {
        current += trimmed[i + 1];
        i += 1;
        continue;
      }
      if (char === "|") {
        cells.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    cells.push(current.trim());
    return cells;
  }

  function isTableDelimiterRow(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
    return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(trimmed);
  }

  function isTableRow(line) {
    return String(line || "").trim().startsWith("|");
  }

  function tableRowsToHtml(rows) {
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const cell = (value, tag) => `<${tag}>${inlineHtml(String(value == null ? "" : value).split("<br>").join("\n"))
      .split("\n")
      .join("<br>")}</${tag}>`;
    const head = `<thead><tr>${rows[0].concat(new Array(Math.max(0, width - rows[0].length)).fill("")).map((value) => cell(value, "th")).join("")}</tr></thead>`;
    const body = rows
      .slice(1)
      .map((row) => `<tr>${row.concat(new Array(Math.max(0, width - row.length)).fill("")).map((value) => cell(value, "td")).join("")}</tr>`)
      .join("\n");
    return `<table>\n${head}\n<tbody>\n${body}\n</tbody>\n</table>`;
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

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      // GFM 表格：当前行以 | 开头且下一行是分隔行
      if (!codeLines && isTableRow(line) && isTableDelimiterRow(lines[lineIndex + 1])) {
        flushAll();
        const rows = [splitTableRow(line)];
        let cursor = lineIndex + 2;
        while (cursor < lines.length && isTableRow(lines[cursor])) {
          rows.push(splitTableRow(lines[cursor]));
          cursor += 1;
        }
        html.push(tableRowsToHtml(rows));
        lineIndex = cursor - 1;
        continue;
      }
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
    splitTableRow,
    isTableDelimiterRow,
    isTableRow,
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
