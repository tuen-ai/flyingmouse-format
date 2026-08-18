// 离线版能力表：源扩展名 -> 分类 / 可选目标格式，以及输出文件名规则。
// 目标格式取所有已选文件的交集（与桌面版一致的产品约定）。
// 输出名沿用 utils.js 的 safeBaseName 语义：保留中文等非 ASCII，去掉 Windows 非法字符，截断 180 字符。
(function (global, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    global.FMOffline = global.FMOffline || {};
    global.FMOffline.formatMap = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // 全部用 null 原型：文件名叫 a.constructor / a.__proto__ 时不能命中 Object.prototype 上的成员
  const EXTENSION_ALIASES = Object.assign(Object.create(null), { jpeg: "jpg", markdown: "md", htm: "html", tif: "tiff" });

  function normalizeExtension(value) {
    const raw = String(value == null ? "" : value).trim().toLowerCase().replace(/^\./, "");
    return EXTENSION_ALIASES[raw] || raw;
  }

  function extensionOf(fileName) {
    const name = String(fileName == null ? "" : fileName);
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) return "";
    return normalizeExtension(name.slice(dot + 1));
  }

  const IMAGE_TARGETS = ["png", "jpg", "webp", "bmp", "ico", "pdf", "zip"];
  const TEXT_TARGETS = ["txt", "md", "html", "csv", "epub", "docx", "zip"];
  const TABLE_TARGETS = ["csv", "tsv", "json", "md", "html", "txt", "docx", "epub", "zip"];
  const JSON_TARGETS = ["json", "csv", "md", "txt", "zip"];
  const XML_TARGETS = ["json", "txt", "zip"];

  const CATEGORIES = Object.assign(Object.create(null), {
    png: "image",
    jpg: "image",
    webp: "image",
    gif: "image",
    bmp: "image",
    ico: "image",
    svg: "image",
    avif: "image",
    txt: "text",
    md: "text",
    html: "text",
    log: "text",
    csv: "table",
    tsv: "table",
    json: "data",
    xml: "data",
  });

  const TARGETS = {
    image: IMAGE_TARGETS,
    text: TEXT_TARGETS,
    table: TABLE_TARGETS,
    data: null,
    unknown: ["zip"],
  };

  function categoryOf(extension) {
    return CATEGORIES[normalizeExtension(extension)] || "unknown";
  }

  function targetsFor(extension) {
    const normalized = normalizeExtension(extension);
    const category = categoryOf(normalized);
    if (category === "data") return normalized === "xml" ? XML_TARGETS.slice() : JSON_TARGETS.slice();
    const targets = TARGETS[category];
    return (targets || TARGETS.unknown).slice();
  }

  // 目标列表交集，保持第一个文件的顺序
  function commonTargets(extensions) {
    const lists = (extensions || []).map((extension) => targetsFor(extension));
    if (lists.length === 0) return [];
    return lists[0].filter((target) => lists.every((list) => list.includes(target)));
  }

  const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function sanitizeFileName(name) {
    const cleaned = String(name == null ? "" : name)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      .replace(/[/?<>\\:*|"]/g, "")
      .replace(/[. ]+$/, "");
    // con.txt / AUX.TXT 在 Windows 上同样是设备名，要按主干判断
    return RESERVED_NAMES.test(cleaned.split(".")[0]) ? "" : cleaned;
  }

  function safeBaseName(originalName) {
    const sanitized = sanitizeFileName(originalName || "file");
    const dot = sanitized.lastIndexOf(".");
    const stem = dot > 0 ? sanitized.slice(0, dot) : sanitized;
    const trimmed = (stem || "converted").trim().slice(0, 180);
    return trimmed || "converted";
  }

  function outputNameFor(originalName, targetExtension, outputExtension) {
    const suffix = !outputExtension || outputExtension === targetExtension
      ? targetExtension
      : `${targetExtension}.${outputExtension}`;
    return `${safeBaseName(originalName)}.${suffix}`;
  }

  const MIME_TYPES = Object.assign(Object.create(null), {
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
    gif: "image/gif",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    xml: "application/xml",
    epub: "application/epub+zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    zip: "application/zip",
  });

  function mimeTypeFor(extension) {
    return MIME_TYPES[normalizeExtension(extension)] || "application/octet-stream";
  }

  return {
    EXTENSION_ALIASES,
    normalizeExtension,
    extensionOf,
    categoryOf,
    targetsFor,
    commonTargets,
    sanitizeFileName,
    safeBaseName,
    outputNameFor,
    mimeTypeFor,
  };
});
