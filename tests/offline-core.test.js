const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const textFormats = require("../offline/core/text-formats.js");
const zipWriter = require("../offline/core/zip-writer.js");
const pdfWriter = require("../offline/core/pdf-writer.js");
const imageCodecs = require("../offline/core/image-codecs.js");
const formatMap = require("../offline/core/format-map.js");
const ebook = require("../offline/core/ebook.js");
const office = require("../offline/core/office.js");
const { convertTextDocument } = require("../offline/core/convert-text.js");

// 桌面版的解析器，用来交叉校验离线版写出的字节
const desktopIco = require("../ico-format.js");
const desktopBmp = require("../bmp-input.js");

// 1x1 baseline JPEG（离线版 PDF 只内嵌 DCTDecode，这里当最小样本）
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    + "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
    + "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

function listZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const crc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString("utf8", offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    const stored = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, method, crc, data: method === 0 ? stored : zlib.inflateRawSync(stored) });
    offset = dataStart + compressedSize;
  }
  return entries;
}

test("严格 CSV：BOM、转义引号、字段内换行、列数不一致报错", () => {
  const records = textFormats.parseCsvRecords('﻿"name","note"\n"鼠鼠","第一行\r\n第二行"\n"a","他说""你好"""\n');
  assert.deepEqual(records, [
    ["name", "note"],
    ["鼠鼠", "第一行\r\n第二行"],
    ["a", '他说"你好"'],
  ]);

  assert.throws(() => textFormats.parseCsvRecords("name,description\n鼠鼠\n"), (error) => {
    assert.equal(error.code, "CSV_PARSE_FAILED");
    assert.match(error.message, /CSV 解析失败/);
    return true;
  });
  assert.throws(() => textFormats.parseCsvRecords('"unterminated\n'), (error) => error.code === "CSV_PARSE_FAILED");
  assert.deepEqual(textFormats.parseCsvRecords("\n\n"), []);
});

test("CSV 表头：空表头补位、重复与危险表头拒绝", () => {
  assert.deepEqual(textFormats.csvToJsonObjects("name,age\nAlice,30"), [{ name: "Alice", age: "30" }]);
  assert.equal(Object.getPrototypeOf(textFormats.csvToJsonObjects("a\n1")[0]), Object.prototype, "输出必须是普通对象");
  assert.deepEqual(textFormats.csvToJsonObjects("name,\nAlice,30"), [{ name: "Alice", column_2: "30" }]);
  assert.throws(() => textFormats.csvToJsonObjects("name,NAME\n1,2"), (error) => /重复/.test(error.message));
  assert.throws(() => textFormats.csvToJsonObjects("__proto__\n1"), (error) => /不安全/.test(error.message));
});

test("CSV -> Markdown / HTML 的转义与空输入", () => {
  assert.equal(textFormats.csvToMarkdown(""), "");
  assert.equal(
    textFormats.csvToMarkdown('"name","note"\n"Mouse","Line one\nLine two"\n'),
    "| name | note |\n| --- | --- |\n| Mouse | Line one<br>Line two |",
  );
  assert.match(textFormats.csvToMarkdown('a,b\n3,"x|y"'), /\| 3 \| x\\\|y \|/);
  assert.equal(textFormats.csvToHtmlTable(""), "<p>（空 CSV）</p>");
  assert.match(textFormats.csvToHtmlTable("a,b\n1,2"), /<table>[\s\S]*<td>1<\/td>/);
});

test("JSON -> CSV：路径扁平化、键排序、全字段加引号、路径冲突报错", () => {
  const csv = textFormats.jsonToCsv(JSON.stringify([
    { name: "Mouse", profile: { address: { city: "Shenzhen" }, score: 3 }, tags: ["cute", { level: 2 }] },
    { name: "Format", profile: { address: { country: "CN" }, score: 4 } },
  ]));
  assert.equal(
    csv,
    '"name","profile.address.city","profile.address.country","profile.score","tags"\n'
      + '"Mouse","Shenzhen","","3","[""cute"",{""level"":2}]"\n'
      + '"Format","","CN","4",""',
  );
  assert.doesNotMatch(csv, /\[object Object\]/);
  assert.throws(
    () => textFormats.jsonToCsv(JSON.stringify([{ "a.b": 1, a: { b: 2 } }])),
    (error) => error.code === "JSON_CSV_PATH_COLLISION" && error.path === "a.b",
  );

  // "__proto__" 字段：既不能污染原型，也不能整列消失
  assert.equal(textFormats.jsonToCsv(String.raw`[{"__proto__":"abc","name":"x"}]`), '"__proto__","name"\n"abc","x"');
  assert.equal(textFormats.jsonToCsv(String.raw`[{"__proto__":{"a":1},"name":"x"}]`), '"__proto__.a","name"\n"1","x"');
  assert.equal({}.a, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("Markdown -> HTML：ATX 标题、fenced 代码块、链接与图片白名单", () => {
  const html = textFormats.markdownToHtml("# Heading\n\n* Mouse\n\n```js\nconst value = 1;\n```\n\n"
    + "[ok](https://example.com) [bad](javascript:alert(1)) ![local](./a.png) ![remote](https://x/a.png)");
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<li>Mouse<\/li>/);
  assert.match(html, /<pre><code class="language-js">const value = 1;\n<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/example\.com">ok<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<img src="\.\/a\.png" alt="local">/);
  assert.doesNotMatch(html, /alt="remote"/);
});

test("HTML -> Markdown：标题、列表、代码块、表格转义与复杂表格降级", () => {
  const markdown = textFormats.htmlToMarkdown(
    '<h1>Hello</h1><ul><li>Mouse</li></ul><pre><code class="language-js">const v=1;</code></pre>'
      + "<table><tr><th>a</th><th>b</th></tr><tr><td>Mouse | Format</td><td>First<br>Second</td></tr></table>",
  );
  assert.match(markdown, /^# Hello/m);
  assert.match(markdown, /^\* Mouse/m);
  assert.match(markdown, /```js\nconst v=1;\n```/);
  assert.match(markdown, /\| Mouse \\\| Format \| First<br>Second \|/);

  const complex = textFormats.htmlToMarkdown(
    '<table><tr><th rowspan="2">Name</th><td onclick="alert(1)"><strong>Mouse</strong></td></tr></table>',
  );
  assert.match(complex, /^<table>/);
  assert.match(complex, /<th rowspan="2">Name<\/th>/);
  assert.match(complex, /<strong>Mouse<\/strong>/);
  assert.doesNotMatch(complex, /onclick|alert/);
});

test("文本转换矩阵：txt->json 带包装警告，xml->json 复用桌面解析器", async () => {
  const wrapped = await convertTextDocument("just some plain text", "txt", "json", {});
  assert.deepEqual(JSON.parse(wrapped.data), { text: "just some plain text" });
  assert.ok(wrapped.warnings.some((warning) => warning.code === "TEXT_JSON_WRAPPED"));

  const fromCsv = await convertTextDocument("name,age\nAlice,30", "csv", "json", {});
  assert.deepEqual(JSON.parse(fromCsv.data), [{ name: "Alice", age: "30" }]);
  assert.equal(fromCsv.warnings.length, 0);

  const fromXml = await convertTextDocument('<root><a id="1">x</a><a>y</a></root>', "xml", "json", {});
  assert.deepEqual(JSON.parse(fromXml.data), { root: { a: [{ "@id": "1", "#text": "x" }, "y"] } });

  const tsv = await convertTextDocument("name\tage\nAlice\t30", "tsv", "csv", { bom: true });
  assert.equal(tsv.data, '﻿"name","age"\n"Alice","30"');

  await assert.rejects(() => convertTextDocument("x", "txt", "mp3", {}), (error) => error.code === "TARGET_UNSUPPORTED");
});

test("ZIP 写入器：条目顺序、CRC 正确、可被 zlib 解压、构建可复现", async () => {
  const entries = [
    { name: "mimetype", data: "application/epub+zip", store: true },
    { name: "hello.txt", data: "鼠鼠".repeat(200) },
  ];
  const first = Buffer.from(await zipWriter.createZipCompressed(entries));
  const second = Buffer.from(await zipWriter.createZipCompressed(entries));
  assert.deepEqual(first, second, "同样输入必须产出同样字节");

  const parsed = listZipEntries(first);
  assert.deepEqual(parsed.map((entry) => entry.name), ["mimetype", "hello.txt"]);
  assert.equal(parsed[0].method, 0);
  assert.equal(parsed[0].data.toString("utf8"), "application/epub+zip");
  assert.equal(parsed[1].data.toString("utf8"), "鼠鼠".repeat(200));
  assert.equal(parsed[1].crc, zipWriter.crc32(new TextEncoder().encode("鼠鼠".repeat(200))));
});

test("EPUB：mimetype 必须第一个且不压缩，目录结构与桌面版一致", async () => {
  const bytes = Buffer.from(await ebook.createEpub("# 第一章\n\n正文\n\n## 第二节\n\n- 一", {
    title: "测试书",
    source: "md",
    uuid: "00000000-0000-4000-8000-000000000000",
  }));
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const entries = listZipEntries(bytes);
  assert.equal(entries[0].name, "mimetype");
  assert.equal(entries[0].method, 0);
  assert.deepEqual(entries.slice(0, 5).map((entry) => entry.name), [
    "mimetype",
    "META-INF/container.xml",
    "OEBPS/content.opf",
    "OEBPS/toc.ncx",
    "OEBPS/chapter-1.xhtml",
  ]);
  const opf = entries[2].data.toString("utf8");
  assert.match(opf, /<dc:title>测试书<\/dc:title>/);
  assert.match(opf, /urn:uuid:00000000-0000-4000-8000-000000000000/);
  // dtb:uid 写真实标识符（桌面版写死 "bookid"，epubcheck 会判为与 OPF 不一致）
  assert.match(entries[3].data.toString("utf8"), /<meta name="dtb:uid" content="urn:uuid:00000000-0000-4000-8000-000000000000"\/>/);
});

test("EPUB 分章：md 按标题切分，纯文本按 2000 字聚合", () => {
  const parts = ebook.splitChapters("# A\n\nbody1\n\n## B\n\nbody2", "md");
  assert.ok(parts.length >= 2);
  assert.equal(parts[0].title, "A");
  assert.match(parts[0].body, /body1/);

  const plain = ebook.splitChapters(`${"字".repeat(2500)}\n\n${"文".repeat(100)}`, "txt");
  assert.equal(plain[0].title, "第 1 节");
  assert.ok(plain.length >= 2);
  assert.deepEqual(ebook.splitChapters("", "txt"), [{ title: "正文", body: "" }]);
});

test("DOCX：包结构完整、表格与中文正文写入 document.xml", async () => {
  const bytes = Buffer.from(await office.createDocx([
    { type: "heading", level: 1, text: "标题" },
    { type: "paragraph", text: "鼠鼠很可爱" },
    { type: "table", rows: [["name", "note"], ["鼠鼠", "可爱"]] },
  ]));
  const entries = listZipEntries(bytes);
  assert.deepEqual(entries.map((entry) => entry.name), [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/_rels/document.xml.rels",
    "word/document.xml",
    "word/styles.xml",
  ]);
  const document = entries.find((entry) => entry.name === "word/document.xml").data.toString("utf8");
  assert.match(document, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(document, /鼠鼠很可爱/);
  assert.match(document, /<w:tbl>/);
});

test("PDF 写入器：页数、xref 偏移与 DCTDecode 图像对象", () => {
  const jpeg = new Uint8Array(TINY_JPEG);
  const pdf = Buffer.from(pdfWriter.createImagePdf([{ data: jpeg }, { data: jpeg }], { paper: "a4", margin: 24 }));
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.equal((text.match(/\/Type \/Page[^s]/g) || []).length, 2);
  assert.match(text, /\/Filter \/DCTDecode/);

  const startxref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 4), "xref");
  const offsets = text.slice(startxref).split("\n").slice(2).filter((line) => /^\d{10} 00000 n $/.test(line));
  assert.equal(offsets.length, 8);
  for (const line of offsets) {
    assert.match(text.slice(Number(line.slice(0, 10))), /^\d+ 0 obj/);
  }
  assert.throws(() => pdfWriter.createImagePdf([], {}), /at least one image/);
  assert.throws(() => pdfWriter.readJpegInfo(new Uint8Array([1, 2, 3, 4])), /not a JPEG/);
});

test("BMP：离线版写出的字节能被桌面版 bmp-input.js 解回同样像素", () => {
  const width = 3;
  const height = 2;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = 10 + i;
    data[i * 4 + 1] = 100 + i;
    data[i * 4 + 2] = 200 + i;
    data[i * 4 + 3] = 255;
  }
  const bmp = Buffer.from(imageCodecs.encodeBmp({ width, height, data }));
  assert.ok(desktopBmp.isBmpBuffer(bmp));
  const decodedByDesktop = desktopBmp.decodeBmpToRaw(bmp);
  assert.equal(decodedByDesktop.width, width);
  assert.equal(decodedByDesktop.height, height);
  assert.equal(decodedByDesktop.channels, 3);
  assert.deepEqual(
    Array.from(decodedByDesktop.data.subarray(0, 3)),
    [data[0], data[1], data[2]],
  );

  const decodedByOffline = imageCodecs.decodeBmp(new Uint8Array(bmp));
  assert.equal(decodedByOffline.width, width);
  assert.deepEqual(Array.from(decodedByOffline.data.subarray(0, 4)), [data[0], data[1], data[2], 255]);
});

test("BMP 透明像素按所选背景合成，压缩变体明确报错", () => {
  const data = new Uint8Array([0, 0, 0, 0]);
  const white = Buffer.from(imageCodecs.encodeBmp({ width: 1, height: 1, data }));
  assert.deepEqual(Array.from(desktopBmp.decodeBmpToRaw(white).data), [255, 255, 255]);
  const black = Buffer.from(imageCodecs.encodeBmp({ width: 1, height: 1, data }, { background: "black" }));
  assert.deepEqual(Array.from(desktopBmp.decodeBmpToRaw(black).data), [0, 0, 0]);

  const compressed = Buffer.from(white);
  compressed.writeUInt32LE(1, 30);
  assert.throws(() => imageCodecs.decodeBmp(new Uint8Array(compressed)), (error) => {
    assert.equal(error.code, "BMP_UNSUPPORTED_VARIANT");
    assert.match(error.message, /压缩/);
    return true;
  });
});

test("ICO：离线版写出的图标能被桌面版 ico-format.js 解析", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const icoBytes = Buffer.from(imageCodecs.encodeIco([
    { size: 16, data: new Uint8Array(png) },
    { size: 32, data: new Uint8Array(png) },
    { size: 256, data: new Uint8Array(png) },
  ]));
  assert.ok(desktopIco.isIcoBuffer(icoBytes));
  assert.equal(icoBytes[6], 16);
  assert.equal(icoBytes[6 + 16], 32);
  assert.equal(icoBytes[6 + 32], 0, "256 像素必须写 0");
  const frames = desktopIco.extractAllFrames(icoBytes);
  assert.equal(frames.length, 3);
  assert.ok(frames.every((frame) => frame.png));
  assert.throws(() => imageCodecs.encodeIco([]), /没有可写入 ICO 的 PNG 帧/);
});

test("能力表：目标取交集、扩展名归一化、输出名保留中文", () => {
  assert.equal(formatMap.normalizeExtension(".JPEG"), "jpg");
  assert.equal(formatMap.extensionOf("白兰的-得意的笑.PNG"), "png");
  assert.equal(formatMap.categoryOf("md"), "text");
  assert.equal(formatMap.categoryOf("mp3"), "unknown");

  assert.deepEqual(formatMap.commonTargets(["png", "jpg"]), ["png", "jpg", "webp", "bmp", "ico", "pdf", "zip"]);
  assert.deepEqual(formatMap.commonTargets(["png", "md"]), ["zip"], "混合队列只剩打包能力");
  assert.deepEqual(formatMap.commonTargets(["mp3"]), ["zip"]);
  assert.deepEqual(formatMap.commonTargets([]), []);

  assert.equal(formatMap.safeBaseName("白兰的-得意的笑.mp3"), "白兰的-得意的笑");
  assert.equal(formatMap.safeBaseName("Zhen Zhen （半夏水玉）-目瑙纵歌.kwm"), "Zhen Zhen （半夏水玉）-目瑙纵歌");
  assert.equal(formatMap.safeBaseName(""), "file", "与桌面版 utils.safeBaseName 一致：空名回落到 file");
  assert.equal(formatMap.safeBaseName("a/b:c*d?.txt"), "abcd");
  assert.equal(formatMap.outputNameFor("鼠鼠.png", "webp"), "鼠鼠.webp");
  assert.equal(formatMap.outputNameFor("doc.pdf", "png", "zip"), "doc.png.zip");
  assert.equal(formatMap.mimeTypeFor("epub"), "application/epub+zip");
});

test("空行与显式空字段行的区别：单列 CSV 不能丢行", () => {
  assert.deepEqual(textFormats.parseCsvRecords('a\n""\nb'), [["a"], [""], ["b"]]);
  assert.deepEqual(textFormats.parseCsvRecords('a\n""'), [["a"], [""]]);
  assert.deepEqual(textFormats.parseCsvRecords("\n\n"), []);
});

test("GFM 表格：csv -> md -> html 可以往返", () => {
  const markdown = textFormats.csvToMarkdown('"name","note"\n"Mouse","a\nb"\n');
  const html = textFormats.markdownBlocksToHtml(markdown);
  assert.match(html, /<table>/);
  assert.match(html, /<th>name<\/th><th>note<\/th>/);
  assert.match(html, /<td>Mouse<\/td><td>a<br>b<\/td>/);
  assert.match(textFormats.markdownBlocksToHtml("| a |\n| --- |\n| x\\|y |"), /<td>x\|y<\/td>/);
});

test("HTML -> Markdown 也走链接/图片白名单", () => {
  const markdown = textFormats.htmlToMarkdown(
    '<a href="javascript:alert(1)">click</a> <a href="//evil.example/x">rel</a> '
      + '<a href="https://ok.example">ok</a> <img src="javascript:x" alt="a"> <img src="./b.png" alt="b">',
  );
  assert.doesNotMatch(markdown, /javascript:/);
  assert.doesNotMatch(markdown, /evil\.example/);
  assert.match(markdown, /\[ok\]\(https:\/\/ok\.example\)/);
  assert.match(markdown, /!\[b\]\(\.\/b\.png\)/);
  assert.equal(textFormats.isSafeMarkdownLink("//evil.example"), false);
  assert.equal(textFormats.isSafeMarkdownLink("java\u0001script:alert(1)"), false);
});

test("强调解析不吃掉 snake_case 与乘号，反斜杠转义有效", () => {
  assert.equal(textFormats.markdownBlocksToHtml("snake_case_name and 2 * 3 * 4"), "<p>snake_case_name and 2 * 3 * 4</p>");
  assert.equal(textFormats.markdownBlocksToHtml("a \\* b"), "<p>a * b</p>");
  assert.equal(textFormats.markdownBlocksToHtml("**b** and *i*"), "<p><strong>b</strong> and <em>i</em></p>");
});

test("满屏方括号不会退化成 O(n^2)", () => {
  const started = Date.now();
  textFormats.markdownToHtml("[".repeat(60000));
  textFormats.markdownToHtml("![".repeat(60000));
  assert.ok(Date.now() - started < 3000, `链接解析太慢：${Date.now() - started}ms`);
});

test("隐式闭合的 li / td 不会互相嵌套", () => {
  assert.equal(textFormats.htmlToMarkdown("<ul><li><p>a<li>b</ul>"), "* a\n* b");
  assert.equal(textFormats.htmlToMarkdown("<table><tr><td>a<td>b<tr><td>c<td>d</table>"), "| a | b |\n| --- | --- |\n| c | d |");
});

test("嵌套过深的输入按错误处理，不爆栈", () => {
  const deepHtml = "<div>".repeat(20000) + "x" + "</div>".repeat(20000);
  assert.match(textFormats.htmlToMarkdown(deepHtml), /^x$/);
  const deepJson = `[${"{\"a\":".repeat(400)}1${"}".repeat(400)}]`;
  assert.throws(() => textFormats.jsonToCsv(deepJson), (error) => error.code === "JSON_TOO_DEEP");
});

test("CSV 分隔符对读和写都生效", async () => {
  const semicolon = "a;b\n1;2";
  const toJson = await convertTextDocument(semicolon, "csv", "json", { delimiter: ";" });
  assert.deepEqual(JSON.parse(toJson.data), [{ a: "1", b: "2" }]);
  const toMarkdown = await convertTextDocument(semicolon, "csv", "md", { delimiter: ";" });
  assert.equal(toMarkdown.data, "| a | b |\n| --- | --- |\n| 1 | 2 |");
  const toCsv = await convertTextDocument(semicolon, "csv", "csv", { delimiter: ";" });
  assert.equal(toCsv.data, '"a";"b"\n"1";"2"');
  const toTsv = await convertTextDocument(semicolon, "csv", "tsv", { delimiter: ";" });
  assert.equal(toTsv.data, '"a"\t"b"\n"1"\t"2"');
});

test("md 表格进入 DOCX 与 EPUB 时仍是表格", async () => {
  const blocks = office.textToBlocks("# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n", "md");
  assert.deepEqual(blocks[1], { type: "table", rows: [["a", "b"], ["1", "2"]] });
  assert.match(office.blocksToDocumentXml(blocks), /<\/w:tbl><w:p\/>/);
  assert.match(ebook.markdownToXhtml("| a |\n| --- |\n| 1 |"), /<table border="1">/);
  const docx = await convertTextDocument("| a | b |\n| --- | --- |\n| 1 | 2 |", "md", "docx", {});
  assert.ok(docx.data.length > 0);
});

test("DOCX 等宽块的字体写在 run 上而不是段落标记上", () => {
  const xml = office.blocksToDocumentXml([{ type: "code", text: "const a = 1;" }]);
  assert.match(xml, /<w:r><w:rPr><w:rFonts w:ascii="Consolas"/);
});

test("BMP 解码在分配缓冲区前先卡像素总量", () => {
  const header = Buffer.alloc(200);
  header[0] = 0x42;
  header[1] = 0x4d;
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(65535, 18);
  header.writeInt32LE(8192, 22);
  header.writeUInt16LE(1, 28);
  header.writeUInt32LE(0, 30);
  assert.throws(() => imageCodecs.decodeBmp(new Uint8Array(header)), (error) => error.code === "IMAGE_TOO_LARGE");
});

test("ZIP 条目名兜底：不允许 ../、绝对路径、反斜杠", () => {
  assert.equal(zipWriter.safeEntryName("../../evil.sh"), "evil.sh");
  assert.equal(zipWriter.safeEntryName("/etc/passwd"), "etc/passwd");
  assert.equal(zipWriter.safeEntryName("a\\b.txt"), "a/b.txt");
  assert.equal(zipWriter.safeEntryName(".."), "file");
});

test("Windows 设备名带扩展名也要拦下，查表不走原型链", () => {
  assert.equal(formatMap.sanitizeFileName("con.txt"), "");
  assert.equal(formatMap.safeBaseName("AUX.TXT"), "converted");
  assert.equal(formatMap.categoryOf("constructor"), "unknown");
  assert.equal(formatMap.mimeTypeFor("constructor"), "application/octet-stream");
  assert.equal(formatMap.extensionOf("a.constructor"), "constructor");
});

test("章节数封顶后并入最后一章，而不是每段自成一章", () => {
  // 每段就超过 2000 字，正常会切出 150 章；封顶后只能有 100 章（99 + 收尾）
  const paragraphs = new Array(150).fill(0).map((_, index) => `第${index}段${"字".repeat(2100)}`).join("\n\n");
  const parts = ebook.splitChapters(paragraphs, "txt");
  assert.ok(parts.length <= 100, `章节数应封顶，实际 ${parts.length}`);
  assert.ok(parts[parts.length - 1].body.length > 2100 * 40, "多出来的段落应并入最后一章");
});

test("BITMAPCOREHEADER 的 BMP 用 3 字节调色板", () => {
  // 14 字节文件头 + 12 字节 core header + 2 项调色板（3 字节）+ 1 行像素
  const header = Buffer.alloc(14 + 12 + 6 + 4);
  header[0] = 0x42;
  header[1] = 0x4d;
  header.writeUInt32LE(header.length, 2);
  header.writeUInt32LE(14 + 12 + 6, 10);
  header.writeUInt32LE(12, 14);
  header.writeUInt16LE(2, 18);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt16LE(1, 24);
  header[26] = 0x10;
  header[27] = 0x20;
  header[28] = 0x30;
  header[29] = 0x40;
  header[30] = 0x50;
  header[31] = 0x60;
  header[32] = 0b01000000;
  const decoded = imageCodecs.decodeBmp(new Uint8Array(header));
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  assert.deepEqual(Array.from(decoded.data.subarray(0, 8)), [0x30, 0x20, 0x10, 255, 0x60, 0x50, 0x40, 255]);
});
