// BMP / ICO 编解码（Node + 浏览器通用，零依赖，Uint8Array 版）。
// 规则对齐桌面版 bmp-input.js 与 ico-format.js：
//   - BMP：仅未压缩 1/4/8/24/32 位，行按 4 字节对齐，负高度表示自上而下，输出 RGBA。
//   - ICO：ICONDIR(6) + ICONDIRENTRY(16) * n，256 像素写 0，planes=1、bitCount=32，帧顺序保持传入顺序。
(function (global, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    global.FMOffline = global.FMOffline || {};
    global.FMOffline.imageCodecs = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function unsupported(message) {
    const error = new Error(message);
    error.code = "BMP_UNSUPPORTED_VARIANT";
    return error;
  }

  // 与桌面版 resource-policy 同口径：单图 5000 万像素上限，必须在分配像素缓冲区之前判断
  const MAX_DECODE_PIXELS = 50 * 1000 * 1000;

  function isBmpBytes(bytes) {
    return bytes && bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d;
  }

  function isIcoBytes(bytes) {
    if (!bytes || bytes.length < 6) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint16(0, true) === 0 && view.getUint16(2, true) === 1;
  }

  // 解码 BMP -> { width, height, data(RGBA) }
  function decodeBmp(bytes) {
    if (!isBmpBytes(bytes)) throw new Error("不是有效的 BMP 文件。");
    if (bytes.length < 54) throw new Error("BMP 文件头不完整。");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pixelOffset = view.getUint32(10, true);
    const dibSize = view.getUint32(14, true);
    const isCore = dibSize === 12;
    const width = isCore ? view.getUint16(18, true) : view.getInt32(18, true);
    const heightRaw = isCore ? view.getUint16(22, true) : view.getInt32(22, true);
    const bitCount = isCore ? view.getUint16(24, true) : view.getUint16(28, true);
    const compression = isCore ? 0 : view.getUint32(30, true);
    const declaredColors = isCore ? 0 : view.getUint32(46, true);

    if (width <= 0 || heightRaw === 0 || width > 65535 || Math.abs(heightRaw) > 65535) {
      throw new Error(`BMP 尺寸不合法：${width}x${heightRaw}`);
    }
    if (compression !== 0) throw unsupported("暂不支持压缩或特殊编码的 BMP（仅支持未压缩的 24/32 位及调色板 BMP）。");
    if (width * Math.abs(heightRaw) > MAX_DECODE_PIXELS) {
      const error = new Error(`BMP 像素数超出上限：${width}x${Math.abs(heightRaw)}`);
      error.code = "IMAGE_TOO_LARGE";
      throw error;
    }
    if (![1, 4, 8, 24, 32].includes(bitCount)) throw unsupported(`暂不支持 ${bitCount} 位 BMP。`);

    const height = Math.abs(heightRaw);
    const topDown = heightRaw < 0;
    const rowBytes = Math.ceil((width * bitCount) / 8 / 4) * 4;
    if (bytes.length < pixelOffset + rowBytes * height) throw new Error("BMP 像素数据不完整。");

    let palette = null;
    if (bitCount <= 8) {
      const maxEntries = bitCount === 1 ? 2 : bitCount === 4 ? 16 : 256;
      const entries = declaredColors > 0 ? Math.min(declaredColors, maxEntries) : maxEntries;
      const start = 14 + dibSize;
      palette = [];
      for (let i = 0; i < entries; i += 1) {
        const base = start + i * 4;
        palette.push([bytes[base + 2] || 0, bytes[base + 1] || 0, bytes[base] || 0]);
      }
    }

    const data = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row += 1) {
      const sourceRow = topDown ? row : height - 1 - row;
      const srcStart = pixelOffset + sourceRow * rowBytes;
      for (let col = 0; col < width; col += 1) {
        const dst = (row * width + col) * 4;
        let rgb;
        if (bitCount === 24) {
          const src = srcStart + col * 3;
          rgb = [bytes[src + 2], bytes[src + 1], bytes[src]];
        } else if (bitCount === 32) {
          const src = srcStart + col * 4;
          rgb = [bytes[src + 2], bytes[src + 1], bytes[src]];
        } else if (bitCount === 8) {
          rgb = palette[bytes[srcStart + col]] || [0, 0, 0];
        } else if (bitCount === 4) {
          const byte = bytes[srcStart + Math.floor(col / 2)];
          const index = col % 2 === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
          rgb = palette[index] || [0, 0, 0];
        } else {
          const byte = bytes[srcStart + Math.floor(col / 8)];
          const index = (byte >> (7 - (col % 8))) & 1;
          rgb = palette[index] || [0, 0, 0];
        }
        data[dst] = rgb[0];
        data[dst + 1] = rgb[1];
        data[dst + 2] = rgb[2];
        data[dst + 3] = 255;
      }
    }
    return { width, height, data };
  }

  // RGBA -> 24 位未压缩 BMP（自下而上，行 4 字节对齐）；透明像素按 background 合成。
  function encodeBmp(image, options = {}) {
    const { width, height, data } = image;
    if (!width || !height) throw new Error("BMP 尺寸不合法。");
    const background = options.background === "black" ? [0, 0, 0] : [255, 255, 255];
    const rowBytes = Math.ceil((width * 3) / 4) * 4;
    const pixelBytes = rowBytes * height;
    const fileSize = 54 + pixelBytes;
    const out = new Uint8Array(fileSize);
    const view = new DataView(out.buffer);
    out[0] = 0x42;
    out[1] = 0x4d;
    view.setUint32(2, fileSize, true);
    view.setUint32(10, 54, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 24, true);
    view.setUint32(34, pixelBytes, true);
    view.setInt32(38, 2835, true);
    view.setInt32(42, 2835, true);

    for (let row = 0; row < height; row += 1) {
      const sourceRow = height - 1 - row;
      const dstStart = 54 + row * rowBytes;
      for (let col = 0; col < width; col += 1) {
        const src = (sourceRow * width + col) * 4;
        const alpha = data[src + 3] / 255;
        const dst = dstStart + col * 3;
        out[dst] = Math.round(data[src + 2] * alpha + background[2] * (1 - alpha));
        out[dst + 1] = Math.round(data[src + 1] * alpha + background[1] * (1 - alpha));
        out[dst + 2] = Math.round(data[src] * alpha + background[0] * (1 - alpha));
      }
    }
    return out;
  }

  // frames: [{ size, data(PNG bytes) }]，顺序保持不变
  function encodeIco(frames) {
    const usable = (frames || []).filter((frame) => frame && frame.data && frame.data.length > 0);
    if (usable.length === 0) throw new Error("没有可写入 ICO 的 PNG 帧。");
    const headerSize = 6 + usable.length * 16;
    let payloadSize = 0;
    for (const frame of usable) payloadSize += frame.data.length;
    const out = new Uint8Array(headerSize + payloadSize);
    const view = new DataView(out.buffer);
    view.setUint16(0, 0, true);
    view.setUint16(2, 1, true);
    view.setUint16(4, usable.length, true);

    let offset = headerSize;
    usable.forEach((frame, index) => {
      const entry = 6 + index * 16;
      const size = Number(frame.size) >= 256 ? 0 : Number(frame.size);
      out[entry] = size & 0xff;
      out[entry + 1] = size & 0xff;
      out[entry + 2] = 0;
      out[entry + 3] = 0;
      view.setUint16(entry + 4, 1, true);
      view.setUint16(entry + 6, 32, true);
      view.setUint32(entry + 8, frame.data.length, true);
      view.setUint32(entry + 12, offset, true);
      out.set(frame.data, offset);
      offset += frame.data.length;
    });
    return out;
  }

  const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

  return { isBmpBytes, isIcoBytes, decodeBmp, encodeBmp, encodeIco, ICO_SIZES };
});
