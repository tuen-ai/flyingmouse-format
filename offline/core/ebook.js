// EPUB 2.0 生成（Node + 浏览器通用）。布局、命名与分章规则对齐桌面版 ebook.js：
//   mimetype(必须第一个且不压缩) -> META-INF/container.xml -> OEBPS/content.opf -> OEBPS/toc.ncx -> OEBPS/chapter-N.xhtml
(function (global, factory) {
  const api = factory(typeof require === "function" ? require : null);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    global.FMOffline = global.FMOffline || {};
    global.FMOffline.ebook = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (nodeRequire) {
  function zipWriter() {
    if (nodeRequire) return nodeRequire("./zip-writer.js");
    return globalThis.FMOffline.zipWriter;
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

  function escapeHtmlText(text) {
    return String(text == null ? "" : text)
      .split("&")
      .join("&amp;")
      .split("<")
      .join("&lt;")
      .split(">")
      .join("&gt;");
  }

  function cleanTitle(name) {
    const cleaned = String(name || "")
      .replace(/[\\/:*?"<>|]/g, " ")
      .trim()
      .slice(0, 80);
    return cleaned || "Book";
  }

  // md：按标题切章；其它：按空行聚合，每章约 2000 字，最多 99 章
  function splitChapters(raw, source) {
    const text = String(raw == null ? "" : raw).replace(/\r\n/g, "\n");
    if (source === "md" || source === "markdown") {
      const blocks = text.split(/\n(?=#{1,6}\s)/);
      const parts = [];
      for (const block of blocks) {
        const headingMatch = /^#{1,6}\s+(.+)$/m.exec(block);
        const title = headingMatch ? headingMatch[1].trim() : "";
        const body = headingMatch ? block.replace(headingMatch[0], "").trim() : block.trim();
        if (!title && parts.length > 0) {
          parts[parts.length - 1].body = `${parts[parts.length - 1].body}\n\n${body}`.trim();
          continue;
        }
        if (!title && !body) continue;
        parts.push({ title: title || "第 1 章", body });
      }
      if (parts.length > 0) return parts;
    }

    const paragraphs = text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
    const parts = [];
    let buffer = "";
    for (const paragraph of paragraphs) {
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (buffer.length > 2000 || parts.length >= 99) {
        parts.push({ title: `第 ${parts.length + 1} 节`, body: buffer });
        buffer = "";
      }
    }
    if (buffer) parts.push({ title: `第 ${parts.length + 1} 节`, body: buffer });
    if (parts.length === 0) return [{ title: "正文", body: text }];
    return parts;
  }

  // 极简 Markdown -> XHTML（与桌面版一致：标题降一级、无序列表、段落）
  function markdownToXhtml(markdown) {
    const lines = String(markdown == null ? "" : markdown).split("\n");
    const out = [];
    let inList = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (inList) {
          out.push("</ul>");
          inList = false;
        }
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading) {
        if (inList) {
          out.push("</ul>");
          inList = false;
        }
        const level = Math.min(6, heading[1].length + 1);
        out.push(`<h${level}>${escapeHtmlText(heading[2].trim())}</h${level}>`);
        continue;
      }
      const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
      if (bullet) {
        if (!inList) {
          out.push("<ul>");
          inList = true;
        }
        out.push(`<li>${escapeHtmlText(bullet[1].trim())}</li>`);
        continue;
      }
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(`<p>${escapeHtmlText(trimmed)}</p>`);
    }
    if (inList) out.push("</ul>");
    return out.join("\n");
  }

  function plainToXhtml(text) {
    return String(text == null ? "" : text)
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${escapeHtmlText(line)}</p>`)
      .join("\n");
  }

  function chapterXhtml(title, bodyHtml) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml">\n`
      + `<head><title>${escapeXml(title)}</title></head>\n<body>\n<h1>${escapeXml(title)}</h1>\n${bodyHtml}\n</body>\n</html>`;
  }

  const CONTAINER_XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
    + "  <rootfiles>\n"
    + '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
    + "  </rootfiles>\n"
    + "</container>";

  function contentOpf(title, chapters, uuid) {
    const manifest = ['<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>']
      .concat(chapters.map((chapter) => `<item id="${chapter.id}" href="${chapter.href}" media-type="application/xhtml+xml"/>`))
      .join("\n    ");
    const spine = chapters.map((chapter) => `<itemref idref="${chapter.id}"/>`).join("\n    ");
    return `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">\n`
      + `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n`
      + `    <dc:title>${escapeXml(title)}</dc:title>\n`
      + `    <dc:language>zh-CN</dc:language>\n`
      + `    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>\n`
      + `  </metadata>\n`
      + `  <manifest>\n    ${manifest}\n  </manifest>\n`
      + `  <spine toc="ncx">\n    ${spine}\n  </spine>\n`
      + `</package>`;
  }

  function tocNcx(title, chapters) {
    const navPoints = chapters
      .map((chapter, index) => `    <navPoint id="nav-${index + 1}" playOrder="${index + 1}">`
        + `<navLabel><text>${escapeXml(chapter.title)}</text></navLabel>`
        + `<content src="${chapter.href}"/></navPoint>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n`
      + `  <head><meta name="dtb:uid" content="bookid"/></head>\n`
      + `  <docTitle><text>${escapeXml(title)}</text></docTitle>\n`
      + `  <navMap>\n${navPoints}\n  </navMap>\n`
      + `</ncx>`;
  }

  function randomUuid() {
    if (typeof crypto === "object" && crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    if (nodeRequire) return nodeRequire("crypto").randomUUID();
    throw new Error("缺少 UUID 生成能力。");
  }

  /**
   * 生成 EPUB 字节。
   * options: { title, source: 'txt'|'md'|'html', uuid? }
   */
  async function createEpub(raw, options = {}) {
    const zip = zipWriter();
    const source = String(options.source || "txt").toLowerCase();
    const title = cleanTitle(options.title);
    const chapters = splitChapters(raw, source).map((chapter, index) => ({
      title: chapter.title,
      body: chapter.body,
      id: `chapter-${index + 1}`,
      href: `chapter-${index + 1}.xhtml`,
    }));
    const uuid = options.uuid || randomUuid();

    const entries = [
      { name: "mimetype", data: "application/epub+zip", store: true },
      { name: "META-INF/container.xml", data: CONTAINER_XML },
      { name: "OEBPS/content.opf", data: contentOpf(title, chapters, uuid) },
      { name: "OEBPS/toc.ncx", data: tocNcx(title, chapters) },
    ];
    for (const chapter of chapters) {
      const bodyHtml = source === "md" || source === "markdown" ? markdownToXhtml(chapter.body) : plainToXhtml(chapter.body);
      entries.push({ name: `OEBPS/${chapter.href}`, data: chapterXhtml(chapter.title, bodyHtml) });
    }
    return zip.createZipCompressed(entries);
  }

  return { createEpub, splitChapters, markdownToXhtml, plainToXhtml, cleanTitle, chapterXhtml, contentOpf, tocNcx, CONTAINER_XML };
});
