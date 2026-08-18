// 离线单文件工具用的最小 ZIP 写入器（Node + 浏览器通用，无依赖）。
// 只实现 store(0) 与 deflate(8) 两种方式：deflate 数据由调用方提供（浏览器用 CompressionStream，Node 用 zlib）。
// EPUB / DOCX / 打包下载共用；顺序、CRC32 与目录结构必须稳定，测试按字节断言。
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    global.FMOffline = global.FMOffline || {};
    global.FMOffline.zipWriter = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const encoder = new TextEncoder();

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (typeof input === 'string') return encoder.encode(input);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    throw new TypeError('zip entry data must be string, Uint8Array or ArrayBuffer');
  }

  // DOS 时间戳：固定 1980-01-01 00:00:00，保证同样输入产出同样字节（可复现构建）
  const DOS_TIME = 0;
  const DOS_DATE = 33; // (1980-1980)<<9 | 1<<5 | 1

  function concat(chunks) {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function writeUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  /**
   * entries: [{ name, data, deflated?: Uint8Array }]
   * 有 deflated 时用方法 8（调用方已压缩），否则 store。
   */
  // 条目名兜底：即使上层忘了 sanitize，也不允许 ../、绝对路径、反斜杠和控制字符进包
  function safeEntryName(name) {
    const cleaned = String(name == null ? "" : name)
      .replace(/\\/g, "/")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..")
      .join("/");
    return cleaned || "file";
  }

  function createZip(entries) {
    if (entries.length > 65535) throw new Error("ZIP 条目数超过 65535，请分批打包。");
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const nameBytes = encoder.encode(safeEntryName(entry.name));
      const raw = toBytes(entry.data);
      const useDeflate = entry.deflated instanceof Uint8Array && entry.deflated.length < raw.length;
      const stored = useDeflate ? entry.deflated : raw;
      const method = useDeflate ? 8 : 0;
      const crc = crc32(raw);

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);
      writeUint32(localView, 0, 0x04034b50);
      localView.setUint16(4, 20, true); // version needed
      localView.setUint16(6, 0x0800, true); // UTF-8 文件名标志
      localView.setUint16(8, method, true);
      localView.setUint16(10, DOS_TIME, true);
      localView.setUint16(12, DOS_DATE, true);
      writeUint32(localView, 14, crc);
      writeUint32(localView, 18, stored.length);
      writeUint32(localView, 22, raw.length);
      localView.setUint16(26, nameBytes.length, true);
      localView.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);

      chunks.push(localHeader, stored);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      writeUint32(centralView, 0, 0x02014b50);
      centralView.setUint16(4, 20, true); // version made by
      centralView.setUint16(6, 20, true); // version needed
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, method, true);
      centralView.setUint16(12, DOS_TIME, true);
      centralView.setUint16(14, DOS_DATE, true);
      writeUint32(centralView, 16, crc);
      writeUint32(centralView, 20, stored.length);
      writeUint32(centralView, 24, raw.length);
      centralView.setUint16(28, nameBytes.length, true);
      writeUint32(centralView, 42, offset);
      centralHeader.set(nameBytes, 46);
      central.push(centralHeader);

      offset += localHeader.length + stored.length;
    }

    const centralBytes = concat(central);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    writeUint32(endView, 0, 0x06054b50);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    writeUint32(endView, 12, centralBytes.length);
    writeUint32(endView, 16, offset);
    return concat([...chunks, centralBytes, end]);
  }

  // 可选压缩：浏览器 CompressionStream('deflate-raw')，Node zlib；失败时回退 store。
  async function deflateRaw(bytes) {
    try {
      if (typeof CompressionStream === 'function') {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        const buffer = await new Response(stream).arrayBuffer();
        return new Uint8Array(buffer);
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  async function createZipCompressed(entries, { compress = true } = {}) {
    if (!compress) return createZip(entries);
    const prepared = [];
    for (const entry of entries) {
      if (entry.store) {
        prepared.push({ name: entry.name, data: entry.data });
        continue;
      }
      const raw = toBytes(entry.data);
      const deflated = raw.length > 64 ? await deflateRaw(raw) : null;
      prepared.push({ name: entry.name, data: raw, deflated: deflated || undefined });
    }
    return createZip(prepared);
  }

  return { createZip, createZipCompressed, crc32, toBytes, concat, safeEntryName };
});
