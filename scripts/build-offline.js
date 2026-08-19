// 把 offline/ 源码打包成一个自包含的离线 HTML 工具（无外部请求、无 node_modules 依赖）。
// 用法：node scripts/build-offline.js [--check]
//   默认写入 offline/dist/flyingmouse-format-offline.html；--check 只校验产物是否与源码一致（CI/测试用）。
// 构建必须可复现：同样的源码产出同样的字节（鼠鼠图片按固定参数缩放，不写时间戳）。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const OFFLINE_DIR = path.join(ROOT, "offline");
const OUTPUT_PATH = path.join(OFFLINE_DIR, "dist", "flyingmouse-format-offline.html");

// 界面状态：图标由页面内的 SVG 精灵提供（自绘几何图形），构建时不再内联任何位图
const STAGE_STATES = ["idle", "upload", "analyzing", "converting", "batch", "success", "error"];

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function resolveFromOffline(source) {
  const cleaned = source.replace(/^\.\//, "");
  if (cleaned.startsWith("../")) return path.posix.normalize(path.posix.join("offline", cleaned));
  return path.posix.join("offline", cleaned);
}

// 内联脚本里出现 </script> 会提前结束标签，统一转义。
// 另外 HTML 解析器有「script data double escaped」状态：源码里同时出现 <!-- 和 <script 时，
// </script> 会被当成普通文本，整段脚本被吞掉。这种组合无法安全地机械转义，直接 fail closed。
function escapeScript(code, source) {
  if (/<script/i.test(code)) {
    throw new Error(`${source} 含有 "<script" 字面量，会破坏内联脚本，请拆成 "<" + "script"`);
  }
  // HTML 分词器遇到 </script 后跟空白、/ 或 > 就结束脚本，且大小写不敏感，所以不能只替换精确的 "</script>"
  return code.replace(/<\/(script)/gi, (match, tag) => `<\\/${tag}`);
}

// 构建产物里的严格 CSP（不含 'self'：单文件不应再加载任何本地或远程资源）
const STRICT_CSP = "default-src 'none'; img-src data: blob:; media-src blob:; style-src 'unsafe-inline'; "
  + "script-src 'unsafe-inline'; connect-src blob:; form-action 'none'; base-uri 'none'";

function build() {
  const version = JSON.parse(readText("package.json")).version;
  let html = readText("offline/index.html");

  const cssMatch = /\n?\s*<link rel="stylesheet" href="([^"]+)">/.exec(html);
  if (!cssMatch) throw new Error("offline/index.html 缺少样式表引用");
  const css = readText(resolveFromOffline(cssMatch[1]));
  // 用函数形式替换：源码里的 $&、$` 等会被 String.replace 当成替换模式，静默破坏产物
  html = html.replace(cssMatch[0], () => `\n    <style>\n${css}\n    </style>`);

  const cspMatch = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  if (!cspMatch) throw new Error("offline/index.html 缺少 CSP meta");
  html = html.replace(cspMatch[0], () => `<meta http-equiv="Content-Security-Policy" content="${STRICT_CSP}">`);

  const scriptPattern = /[ \t]*<script src="([^"]+)"><\/script>\n?/g;
  const scripts = [];
  let match = scriptPattern.exec(html);
  while (match) {
    scripts.push({ tag: match[0], source: match[1] });
    match = scriptPattern.exec(html);
  }
  if (scripts.length === 0) throw new Error("offline/index.html 缺少脚本引用");

  const runtimeScript = "(function (global) {\n"
    + "  global.FMOffline = global.FMOffline || {};\n"
    + `  global.FMOffline.buildInfo = { version: ${JSON.stringify(version)} };\n`
    + "})(typeof globalThis !== \"undefined\" ? globalThis : this);";

  scripts.forEach((script, index) => {
    const code = readText(resolveFromOffline(script.source));
    const inlined = `    <script>\n${escapeScript(code, script.source)}\n    </script>\n`;
    const prefix = index === scripts.length - 1 ? `    <script>\n${runtimeScript}\n    </script>\n` : "";
    html = html.replace(script.tag, () => prefix + inlined);
  });

  // fail closed：任何还能发起请求的写法都不许留在产物里。
  // 只扫描标记部分（去掉内联脚本体），否则 JS 源码里出现的 "<img" / "@import" 字符串会误报。
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, "<script></script>");
  const externalPatterns = [
    /<img\s/i,
    /<script\s+src=/i,
    /<link\s[^>]*href=/i,
    /(?:src|href)="(?:https?:)?\/\//i,
    /(?:src|href)="\.\.?\//i,
    /@import/i,
    /url\(\s*['"]?(?:https?:)?\/\//i,
  ];
  for (const pattern of externalPatterns) {
    if (pattern.test(markup)) throw new Error(`构建产物仍然可能发起外部请求：${pattern}`);
  }
  if (!html.includes(STRICT_CSP)) throw new Error("构建产物缺少严格 CSP");
  return html;
}

function main() {
  const check = process.argv.includes("--check");
  const html = build();
  const bytes = Buffer.from(html, "utf8");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");

  if (check) {
    if (!fs.existsSync(OUTPUT_PATH)) {
      console.error("FAILED: 缺少构建产物，请运行 node scripts/build-offline.js");
      process.exit(1);
    }
    const current = fs.readFileSync(OUTPUT_PATH);
    if (!current.equals(bytes)) {
      console.error("FAILED: offline/dist 产物与源码不一致，请重新运行 node scripts/build-offline.js");
      process.exit(1);
    }
    console.log(`OK 产物与源码一致（${(bytes.length / 1024).toFixed(1)} KB, sha256 ${digest.slice(0, 16)}…）`);
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, bytes);
  console.log(`OK ${path.relative(ROOT, OUTPUT_PATH)} -> ${(bytes.length / 1024).toFixed(1)} KB`);
  console.log(`sha256 ${digest}`);
}

if (require.main === module) main();

module.exports = { build, STAGE_STATES, OUTPUT_PATH };
