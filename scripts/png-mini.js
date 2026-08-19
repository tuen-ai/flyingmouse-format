// 纯 Node（仅用内置 zlib）的 PNG 解码 / 缩放 / 重编码工具。
// 用途：在没有 sharp（未装 node_modules）的环境里缩小 PNG，例如生成 README 截图。
// 注：离线单文件构建已不再内联位图（图标改成自绘 SVG），这个脚本只作为工具保留。
const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC32（PNG chunk 校验）
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// 解码 8bit truecolor-alpha（colorType 6）或 truecolor（colorType 2）PNG -> { width, height, data(RGBA) }
function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file');
  let offset = 8;
  let ihdr = null;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buf.subarray(dataStart, dataStart + length);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }
  if (!ihdr) throw new Error('PNG missing IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported PNG bit depth: ${ihdr.bitDepth}`);
  if (ihdr.colorType !== 6 && ihdr.colorType !== 2) {
    throw new Error(`unsupported PNG color type: ${ihdr.colorType}`);
  }
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG is not supported');

  const channels = ihdr.colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * channels;
  const out = Buffer.alloc(ihdr.width * ihdr.height * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  const expected = (stride + 1) * ihdr.height;
  if (raw.length < expected) throw new Error(`PNG 像素数据不完整：期望 ${expected} 字节，实际 ${raw.length}`);
  let pos = 0;
  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    raw.copy(line, 0, pos, pos + stride);
    pos += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`unknown PNG filter: ${filter}`);
      line[x] = value & 0xff;
    }
    for (let x = 0; x < ihdr.width; x += 1) {
      const src = x * channels;
      const dst = (y * ihdr.width + x) * 4;
      out[dst] = line[src];
      out[dst + 1] = line[src + 1];
      out[dst + 2] = line[src + 2];
      out[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
    line.copy(prev);
  }
  return { width: ihdr.width, height: ihdr.height, data: out };
}

// 盒式滤波缩放（先乘 alpha，避免透明边缘出现黑边）
function resizeRgba(image, targetWidth, targetHeight) {
  const { width, height, data } = image;
  if (targetWidth <= 0 || targetHeight <= 0) throw new Error('invalid resize target');
  const out = Buffer.alloc(targetWidth * targetHeight * 4);
  const xRatio = width / targetWidth;
  const yRatio = height / targetHeight;
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = Math.floor(ty * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((ty + 1) * yRatio)));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = Math.floor(tx * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((tx + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const idx = (y * width + x) * 4;
          const alpha = data[idx + 3] / 255;
          r += data[idx] * alpha;
          g += data[idx + 1] * alpha;
          b += data[idx + 2] * alpha;
          a += data[idx + 3];
          count += 1;
        }
      }
      const dst = (ty * targetWidth + tx) * 4;
      const avgAlpha = a / count;
      const alphaScale = avgAlpha > 0 ? 255 / avgAlpha : 0;
      out[dst] = Math.min(255, Math.round((r / count) * alphaScale));
      out[dst + 1] = Math.min(255, Math.round((g / count) * alphaScale));
      out[dst + 2] = Math.min(255, Math.round((b / count) * alphaScale));
      out[dst + 3] = Math.round(avgAlpha);
    }
  }
  return { width: targetWidth, height: targetHeight, data: out };
}

// 量化：把 RGB 低位截断（保留 alpha），提高 zlib 命中率，肉眼几乎无差
function quantize(image, bits) {
  if (!bits || bits <= 0) return image;
  const mask = (0xff << bits) & 0xff;
  const half = (1 << bits) >> 1;
  const data = Buffer.from(image.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      continue;
    }
    data[i] = Math.min(255, (data[i] & mask) + half);
    data[i + 1] = Math.min(255, (data[i + 1] & mask) + half);
    data[i + 2] = Math.min(255, (data[i + 2] & mask) + half);
  }
  return { width: image.width, height: image.height, data };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// 自适应行滤波（按绝对值和最小挑选），再用 zlib 最高压缩级别
function encodePng(image) {
  const { width, height, data } = image;
  const stride = width * 4;
  const rows = Buffer.alloc((stride + 1) * height);
  const prev = Buffer.alloc(stride);
  const candidates = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < height; y += 1) {
    const line = data.subarray(y * stride, (y + 1) * stride);
    let best = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter < 5; filter += 1) {
      const target = candidates[filter];
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const a = x >= 4 ? line[x - 4] : 0;
        const b = prev[x];
        const c = x >= 4 ? prev[x - 4] : 0;
        let value = line[x];
        if (filter === 1) value -= a;
        else if (filter === 2) value -= b;
        else if (filter === 3) value -= (a + b) >> 1;
        else if (filter === 4) value -= paeth(a, b, c);
        value &= 0xff;
        target[x] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
      }
    }
    rows[y * (stride + 1)] = best;
    candidates[best].copy(rows, y * (stride + 1) + 1);
    line.copy(prev);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 一步到位：读入 PNG buffer -> 按最长边缩放 -> 量化 -> 重编码
function shrinkPng(buffer, { maxSize = 360, quantizeBits = 3 } = {}) {
  const decoded = decodePng(buffer);
  const scale = Math.min(1, maxSize / Math.max(decoded.width, decoded.height));
  const resized = scale < 1
    ? resizeRgba(decoded, Math.max(1, Math.round(decoded.width * scale)), Math.max(1, Math.round(decoded.height * scale)))
    : decoded;
  return encodePng(quantize(resized, quantizeBits));
}

module.exports = { decodePng, encodePng, resizeRgba, quantize, shrinkPng, crc32 };
