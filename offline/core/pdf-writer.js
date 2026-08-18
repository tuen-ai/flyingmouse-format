// 最小 PDF 1.4 写入器（Node + 浏览器通用，无依赖）：把若干 JPEG 图片按顺序写成多页 PDF。
// 只用 DCTDecode，避免引入 zlib/flate 依赖；浏览器侧由 canvas 统一转成 JPEG 后传入。
// 页面尺寸按图片像素换算成 72dpi 点，或按指定纸张（A4/Letter）等比居中。
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    global.FMOffline = global.FMOffline || {};
    global.FMOffline.pdfWriter = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const encoder = new TextEncoder();

  const PAPER_SIZES = {
    auto: null,
    a4: { width: 595.28, height: 841.89 },
    letter: { width: 612, height: 792 },
  };

  function latin1Bytes(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

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

  // 从 JPEG 字节里读出宽高与颜色分量数（SOF0..SOF15，跳过 SOF4/SOF8/SOF12）
  function readJpegInfo(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG image');
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        const components = bytes[offset + 9];
        return { width, height, components };
      }
      offset += 2 + length;
    }
    throw new Error('JPEG SOF marker not found');
  }

  function fitPage(image, paper, marginPt) {
    if (!paper) {
      return {
        pageWidth: (image.width * 72) / 96,
        pageHeight: (image.height * 72) / 96,
        drawWidth: (image.width * 72) / 96,
        drawHeight: (image.height * 72) / 96,
        x: 0,
        y: 0,
      };
    }
    const margin = Math.max(0, marginPt);
    const usableWidth = Math.max(1, paper.width - margin * 2);
    const usableHeight = Math.max(1, paper.height - margin * 2);
    const scale = Math.min(usableWidth / image.width, usableHeight / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    return {
      pageWidth: paper.width,
      pageHeight: paper.height,
      drawWidth,
      drawHeight,
      x: (paper.width - drawWidth) / 2,
      y: (paper.height - drawHeight) / 2,
    };
  }

  function formatNumber(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  /**
   * images: [{ data: Uint8Array(JPEG) }]
   * options: { paper: 'auto'|'a4'|'letter', margin: number(pt), title?: string }
   */
  function createImagePdf(images, options = {}) {
    if (!Array.isArray(images) || images.length === 0) throw new Error('at least one image is required');
    const paperKey = String(options.paper || 'auto').toLowerCase();
    if (!(paperKey in PAPER_SIZES)) throw new Error(`unknown paper size: ${options.paper}`);
    const paper = PAPER_SIZES[paperKey];
    const margin = Number.isFinite(options.margin) ? options.margin : 24;

    const pages = images.map((image) => {
      const info = readJpegInfo(image.data);
      return { data: image.data, info, layout: fitPage(info, paper, margin) };
    });

    // 对象编号：1 catalog，2 pages，之后每页 3 个对象（page / content / image）
    const objects = [];
    const pageIds = pages.map((_, index) => 3 + index * 3);
    const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
    objects.push({ id: 1, body: latin1Bytes('<< /Type /Catalog /Pages 2 0 R >>') });
    objects.push({ id: 2, body: latin1Bytes(`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`) });

    pages.forEach((page, index) => {
      const pageId = pageIds[index];
      const contentId = pageId + 1;
      const imageId = pageId + 2;
      const { layout } = page;
      objects.push({
        id: pageId,
        body: latin1Bytes(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatNumber(layout.pageWidth)} ${formatNumber(layout.pageHeight)}] `
            + `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
        ),
      });

      const content = `q\n${formatNumber(layout.drawWidth)} 0 0 ${formatNumber(layout.drawHeight)} `
        + `${formatNumber(layout.x)} ${formatNumber(layout.y)} cm\n/Im0 Do\nQ\n`;
      const contentBytes = latin1Bytes(content);
      objects.push({
        id: contentId,
        body: concat([latin1Bytes(`<< /Length ${contentBytes.length} >>\nstream\n`), contentBytes, latin1Bytes('\nendstream')]),
      });

      const colorSpace = page.info.components === 1 ? '/DeviceGray' : page.info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      const header = `<< /Type /XObject /Subtype /Image /Width ${page.info.width} /Height ${page.info.height} `
        + `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.data.length} >>\nstream\n`;
      objects.push({
        id: imageId,
        body: concat([latin1Bytes(header), page.data, latin1Bytes('\nendstream')]),
      });
    });

    objects.sort((a, b) => a.id - b.id);

    const chunks = [];
    let position = 0;
    const push = (bytes) => {
      chunks.push(bytes);
      position += bytes.length;
    };

    push(latin1Bytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    const offsets = new Map();
    for (const object of objects) {
      offsets.set(object.id, position);
      push(latin1Bytes(`${object.id} 0 obj\n`));
      push(object.body);
      push(latin1Bytes('\nendobj\n'));
    }

    const xrefOffset = position;
    const maxId = objects[objects.length - 1].id;
    let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= maxId; id += 1) {
      const offset = offsets.get(id) || 0;
      xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    push(latin1Bytes(xref));
    push(latin1Bytes(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
    return concat(chunks);
  }

  return { createImagePdf, readJpegInfo, PAPER_SIZES, encoder };
});
