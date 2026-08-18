const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { build, OUTPUT_PATH, MOUSE_STATES } = require("../scripts/build-offline.js");
const { decodePng, encodePng, shrinkPng } = require("../scripts/png-mini.js");

const ROOT = path.join(__dirname, "..");

test("构建产物已提交且与源码一致（改了 offline/ 就要重跑 build-offline）", () => {
  assert.ok(fs.existsSync(OUTPUT_PATH), "缺少 offline/dist 产物");
  const committed = fs.readFileSync(OUTPUT_PATH, "utf8");
  assert.equal(build(), committed, "请运行 node scripts/build-offline.js 重新生成离线单文件");
});

test("构建可复现：同样源码两次构建字节一致", () => {
  assert.equal(build(), build());
});

test("单文件产物不含任何外部引用", () => {
  const html = build();
  assert.doesNotMatch(html, /<script\s+src=/);
  assert.doesNotMatch(html, /<link\s+rel="stylesheet"/);
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//);
  assert.doesNotMatch(html, /(?:src|href)="\.\.?\//);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /<style>/);
});

test("鼠鼠状态图全部内联为 data URI，体积保持在 1MB 以内", () => {
  const html = build();
  const dataUris = html.match(/data:image\/png;base64,/g) || [];
  assert.ok(dataUris.length >= MOUSE_STATES.length, `内联鼠鼠图片数量不足：${dataUris.length}`);
  assert.match(html, /id="mouseMascot"/);
  assert.match(html, /FMOffline\.mouseAssets/);
  for (const state of MOUSE_STATES) {
    assert.ok(html.includes(`"${state}": "data:image/png;base64,`), `缺少鼠鼠状态 ${state}`);
  }
  const bytes = Buffer.byteLength(html, "utf8");
  assert.ok(bytes < 1024 * 1024, `离线单文件过大：${bytes} 字节`);
});

test("产物保留品牌与非商用声明", () => {
  const html = build();
  assert.match(html, /鼠鼠/);
  assert.match(html, /禁止商业售卖/);
  assert.match(html, /FlyingMouse Format/);
});

test("PNG 工具：解码 -> 缩放 -> 重编码后仍是合法 PNG 且尺寸正确", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "assets", "mouse-format", "mouse-idle.png"));
  const original = decodePng(source);
  assert.equal(original.width, 720);
  assert.equal(original.height, 540);
  assert.equal(original.data.length, 720 * 540 * 4);

  const shrunk = shrinkPng(source, { maxSize: 320, quantizeBits: 3 });
  assert.deepEqual(shrunk.subarray(1, 4).toString("latin1"), "PNG");
  const decoded = decodePng(shrunk);
  assert.equal(decoded.width, 320);
  assert.equal(decoded.height, 240);
  assert.ok(shrunk.length < source.length / 4, "缩放后体积应显著变小");

  const roundTrip = decodePng(encodePng(decoded));
  assert.equal(roundTrip.width, decoded.width);
  assert.deepEqual(roundTrip.data, decoded.data, "编码/解码必须无损");
});
