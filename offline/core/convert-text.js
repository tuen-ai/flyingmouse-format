// 文本类转换编排（Node + 浏览器通用）：把「源扩展名 + 目标扩展名 + 选项」映射到具体转换。
// 矩阵与桌面版 text-docx.js 的 convertText 对齐，包括 TEXT_JSON_WRAPPED 这类非致命警告。
(function (global, factory) {
  const api = factory(typeof require === "function" ? require : null);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    global.FMOffline = global.FMOffline || {};
    global.FMOffline.convertText = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (nodeRequire) {
  function deps() {
    if (nodeRequire) {
      return {
        text: nodeRequire("./text-formats.js"),
        ebook: nodeRequire("./ebook.js"),
        office: nodeRequire("./office.js"),
        xml: nodeRequire("../../xml-json.js"),
      };
    }
    const offline = globalThis.FMOffline;
    return {
      text: offline.textFormats,
      ebook: offline.ebook,
      office: offline.office,
      xml: globalThis.FlyingMouseXmlJson,
    };
  }

  const WARNING_MESSAGES = {
    TEXT_JSON_WRAPPED: {
      zhCN: "源文件不是结构化数据，已包装为 { \"text\": ... } 后输出 JSON。",
      enUS: 'The source is not structured data, so it was wrapped as { "text": ... }.',
    },
    TSV_NORMALIZED: {
      zhCN: "TSV 已按制表符解析后再输出。",
      enUS: "The TSV source was parsed with tab delimiters before conversion.",
    },
    EPUB_PLAIN_BODY: {
      zhCN: "HTML 源已先转为 Markdown 再生成电子书，复杂版式可能丢失。",
      enUS: "HTML sources are converted to Markdown before building the e-book, so complex layouts may be lost.",
    },
  };

  function warning(code) {
    return { code, messages: WARNING_MESSAGES[code] };
  }

  function tabularRecords(raw, source, options, textFormats) {
    const delimiter = source === "tsv" ? "\t" : options.delimiter || ",";
    return textFormats.parseCsvRecords(raw, { delimiter });
  }

  function isTabular(source) {
    return source === "csv" || source === "tsv";
  }

  /**
   * raw: 源文本；source/target: 规范化扩展名。
   * options: { delimiter, bom, title }
   * 返回 { data: string | Uint8Array, warnings: [], binary: boolean }
   */
  async function convertTextDocument(raw, source, target, options = {}) {
    const { text: textFormats, ebook, office, xml } = deps();
    const warnings = [];
    const input = String(raw == null ? "" : raw);
    const delimiter = options.delimiter || ",";

    const asCsvText = () => {
      if (source === "tsv") {
        warnings.push(warning("TSV_NORMALIZED"));
        return textFormats.serializeCsv(tabularRecords(input, source, options, textFormats), { delimiter: "," });
      }
      return input;
    };

    if (target === "txt") {
      if (source === "html") return { data: textFormats.htmlToText(input), warnings, binary: false };
      if (source === "json") return { data: textFormats.jsonPretty(input), warnings, binary: false };
      if (source === "xml") return { data: JSON.stringify(xml.xmlToJson(input), null, 2), warnings, binary: false };
      return { data: input, warnings, binary: false };
    }

    if (target === "html") {
      if (source === "md") return { data: textFormats.markdownToHtml(input), warnings, binary: false };
      if (source === "html") return { data: input, warnings, binary: false };
      if (isTabular(source)) return { data: textFormats.csvToHtmlTable(asCsvText(), { delimiter: "," }), warnings, binary: false };
      return { data: textFormats.textToHtml(input), warnings, binary: false };
    }

    if (target === "md") {
      if (source === "html") return { data: textFormats.htmlToMarkdown(input), warnings, binary: false };
      if (source === "json") return { data: `\`\`\`json\n${textFormats.jsonPretty(input)}\n\`\`\`\n`, warnings, binary: false };
      if (isTabular(source)) return { data: textFormats.csvToMarkdown(asCsvText(), { delimiter: "," }), warnings, binary: false };
      return { data: input, warnings, binary: false };
    }

    if (target === "json") {
      if (source === "json") return { data: textFormats.jsonPretty(input), warnings, binary: false };
      if (isTabular(source)) {
        const rows = textFormats.csvToJsonObjects(asCsvText(), { delimiter: "," });
        return { data: JSON.stringify(rows, null, 2), warnings, binary: false };
      }
      if (source === "xml") return { data: JSON.stringify(xml.xmlToJson(input), null, 2), warnings, binary: false };
      warnings.push(warning("TEXT_JSON_WRAPPED"));
      return { data: JSON.stringify({ text: input }, null, 2), warnings, binary: false };
    }

    if (target === "csv" || target === "tsv") {
      const outDelimiter = target === "tsv" ? "\t" : delimiter;
      if (source === "json") {
        const csv = textFormats.jsonToCsv(input);
        if (target === "csv" && outDelimiter === ",") {
          return { data: options.bom ? `\uFEFF${csv}` : csv, warnings, binary: false };
        }
        const records = textFormats.parseCsvRecords(csv, { delimiter: "," });
        return { data: textFormats.serializeCsv(records, { delimiter: outDelimiter, bom: options.bom }), warnings, binary: false };
      }
      if (isTabular(source)) {
        const records = tabularRecords(input, source, options, textFormats);
        return { data: textFormats.serializeCsv(records, { delimiter: outDelimiter, bom: options.bom }), warnings, binary: false };
      }
      const lines = textFormats.textToCsvLines(input);
      return { data: options.bom ? `\uFEFF${lines}` : lines, warnings, binary: false };
    }

    if (target === "epub") {
      let body = input;
      let epubSource = source;
      if (source === "html") {
        body = textFormats.htmlToMarkdown(input);
        epubSource = "md";
        warnings.push(warning("EPUB_PLAIN_BODY"));
      } else if (isTabular(source)) {
        body = textFormats.csvToMarkdown(asCsvText(), { delimiter: "," });
        epubSource = "md";
      } else if (source === "json") {
        body = `\`\`\`json\n${textFormats.jsonPretty(input)}\n\`\`\``;
        epubSource = "txt";
      }
      const data = await ebook.createEpub(body, { title: options.title, source: epubSource, uuid: options.uuid });
      return { data, warnings, binary: true };
    }

    if (target === "docx") {
      let blocks;
      if (isTabular(source)) {
        blocks = [{ type: "table", rows: tabularRecords(input, source, options, textFormats) }];
      } else if (source === "html") {
        blocks = office.textToBlocks(textFormats.htmlToMarkdown(input), "md");
      } else if (source === "json") {
        blocks = [{ type: "code", text: textFormats.jsonPretty(input) }];
      } else {
        blocks = office.textToBlocks(input, source);
      }
      if (options.title) blocks = [{ type: "heading", level: 1, text: options.title }].concat(blocks);
      const data = await office.createDocx(blocks);
      return { data, warnings, binary: true };
    }

    const error = new Error(`暂不支持的目标格式：${target}`);
    error.code = "TARGET_UNSUPPORTED";
    throw error;
  }

  return { convertTextDocument, WARNING_MESSAGES };
});
