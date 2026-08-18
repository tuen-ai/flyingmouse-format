const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function readOffline(relativePath) {
  return fs.readFileSync(path.join(ROOT, "offline", relativePath), "utf8");
}

const html = readOffline("index.html");
const appJs = readOffline("app/app.js");
const css = readOffline("styles.css");
const messages = require("../offline/app/messages.js");

test("离线版页面保留鼠鼠品牌与上传台锚点", () => {
  assert.match(html, /id="mouseMascot"/);
  assert.match(html, /class="mouse-mascot"/);
  assert.match(html, /id="brandMouse"/);
  assert.match(html, /mouse-format\/mouse-upload\.png/);
  assert.match(html, /id="dropZone"/);
  assert.match(html, /id="dropHint"/);
  assert.match(html, /把文件丢给鼠鼠/);
});

test("离线版必须声明 CSP 且禁止外部资源", () => {
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /https?:\/\//, "源页面不得引用任何外部地址");
});

test("脚本顺序：i18n / 偏好 / 核心模块都在 app.js 之前", () => {
  const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
  assert.ok(order.length >= 10);
  assert.equal(order[0], "../public/i18n.js");
  assert.equal(order[1], "../public/conversion-preferences.js");
  assert.equal(order[order.length - 1], "./app/app.js");
  for (const required of ["./core/zip-writer.js", "./core/text-formats.js", "./core/format-map.js", "./app/messages.js"]) {
    assert.ok(order.includes(required), `缺少脚本 ${required}`);
    assert.ok(order.indexOf(required) < order.indexOf("./app/app.js"));
  }
});

test("控件 id 与设置面板默认隐藏", () => {
  for (const id of ["languageSelect", "themeToggle", "targetGroup", "convertButton", "statusLine", "resultList", "queueList", "downloadAllButton", "toast"]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`);
  }
  assert.match(html, /<option value="zh-CN">/);
  assert.match(html, /<option value="en-US">/);
  for (const id of ["imageOptions", "pdfOptions", "textOptions"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*hidden`), `#${id} 必须默认隐藏`);
  }
  assert.match(html, /id="workbench"[^>]*hidden/);
  assert.match(html, /id="resultsCard"[^>]*hidden/);
});

test("渲染层禁止动态 innerHTML，必须走 textContent", () => {
  assert.doesNotMatch(appJs, /\.innerHTML\s*=/);
  assert.doesNotMatch(readOffline("app/image-runtime.js"), /\.innerHTML\s*=/);
  assert.match(appJs, /\.textContent\s*=/);
  assert.match(appJs, /function createTextElement/);
  assert.match(appJs, /replaceChildren/);
});

test("鼠鼠状态机覆盖上传/识别/转换/批量/成功/失败，且状态图存在", () => {
  assert.match(appJs, /function setMouseState/);
  assert.match(appJs, /mouseMascot\.dataset\.state = name/);
  const states = ["idle", "upload", "analyzing", "converting", "batch", "success", "error"];
  for (const state of states) {
    assert.match(appJs, new RegExp(`${state}:`), `mouseAssets 缺少状态 ${state}`);
    const asset = path.join(ROOT, "public", "assets", "mouse-format", `mouse-${state}.png`);
    assert.ok(fs.existsSync(asset), `缺少鼠鼠状态图 ${asset}`);
    assert.ok(fs.statSync(asset).size > 100);
  }
  assert.match(appJs, /setMouseState\("success"\)/);
  assert.match(appJs, /setMouseState\("error"\)/);
  assert.match(appJs, /\? "batch" :/, "批量状态按队列数量切换");
});

test("中英文文案键集合必须一致，且保留非商用声明", () => {
  const zh = Object.keys(messages["zh-CN"]).sort();
  const en = Object.keys(messages["en-US"]).sort();
  assert.deepEqual(zh, en, "zh-CN 与 en-US 的 key 必须完全一致");
  assert.ok(zh.length > 50);
  assert.match(messages["zh-CN"]["footer.notice"], /禁止商业售卖/);
  assert.match(messages["zh-CN"]["footer.scope"], /桌面版/);
  assert.match(messages["en-US"]["footer.notice"], /personal use only/i);
  assert.doesNotMatch(JSON.stringify(messages), /3465177342@qq\.com/);
  for (const key of zh) {
    assert.equal(typeof messages["zh-CN"][key], "string");
    assert.ok(messages["zh-CN"][key].length > 0, `${key} 不能为空`);
  }
});

test("语言与偏好复用桌面版模块与存储键", () => {
  assert.match(appJs, /FlyingMouseI18n/);
  assert.match(appJs, /FlyingMouseConversionPreferences/);
  assert.match(appJs, /preferencesModule\.rememberTarget/);
  assert.match(appJs, /preferencesModule\.preferredTarget/);
  assert.match(appJs, /flyingmouse\.theme\.v1/);
  const i18nSource = fs.readFileSync(path.join(ROOT, "public", "i18n.js"), "utf8");
  assert.match(i18nSource, /flyingmouse\.language\.v1/);
});

test("样式保留鼠鼠主色、双主题与降级动画", () => {
  assert.match(css, /--accent: #e95f6d/);
  assert.match(css, /\.mouse-mascot/);
  assert.match(css, /\.dropzone/);
  assert.match(css, /\[data-theme='dark'\]/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\[hidden\] \{\n {2}display: none !important;/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.doesNotMatch(css, /@import|url\(https?:/, "样式不得加载外部资源");
});
