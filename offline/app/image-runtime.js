// 浏览器端图片管线：解码 -> 缩放/合成 -> 编码。只用 Canvas 与本地编解码器，不联网。
// PNG/JPEG/WebP 由浏览器编码；BMP 与 ICO 由 core/image-codecs.js 自己写字节。
(function (global) {
  const offline = (global.FMOffline = global.FMOffline || {});

  const CANVAS_MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

  function codecs() {
    return offline.imageCodecs;
  }

  async function blobToBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  function drawToCanvas(source, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function loadViaImageElement(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("image decode failed"));
      };
      image.src = url;
    });
  }

  // 解码顺序：createImageBitmap -> <img> -> 自带 BMP 解码器
  async function decodeImage(file) {
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = drawToCanvas(bitmap, bitmap.width, bitmap.height);
      if (typeof bitmap.close === "function") bitmap.close();
      return canvas;
    } catch (error) {
      // 继续尝试其它解码方式
    }
    try {
      const image = await loadViaImageElement(file);
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) throw new Error("image has no intrinsic size");
      return drawToCanvas(image, width, height);
    } catch (error) {
      // 继续尝试本地 BMP 解码
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (codecs().isBmpBytes(bytes)) {
      const decoded = codecs().decodeBmp(bytes);
      const canvas = document.createElement("canvas");
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      const context = canvas.getContext("2d");
      const imageData = context.createImageData(decoded.width, decoded.height);
      imageData.data.set(decoded.data);
      context.putImageData(imageData, 0, 0);
      return canvas;
    }
    const error = new Error("unsupported image encoding");
    error.code = "IMAGE_DECODE_FAILED";
    throw error;
  }

  function resizeCanvas(canvas, maxSize) {
    const limit = Number(maxSize) || 0;
    if (limit <= 0) return canvas;
    const longest = Math.max(canvas.width, canvas.height);
    if (longest <= limit) return canvas;
    const scale = limit / longest;
    return drawToCanvas(canvas, canvas.width * scale, canvas.height * scale);
  }

  function flattenCanvas(canvas, background) {
    const output = document.createElement("canvas");
    output.width = canvas.width;
    output.height = canvas.height;
    const context = output.getContext("2d");
    context.fillStyle = background === "black" ? "#000000" : "#ffffff";
    context.fillRect(0, 0, output.width, output.height);
    context.drawImage(canvas, 0, 0);
    return output;
  }

  function hasAlpha(canvas) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 255) return true;
    }
    return false;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error(`canvas encoding failed for ${mime}`));
        },
        mime,
        quality,
      );
    });
  }

  async function encodeCanvas(canvas, target, options = {}) {
    const quality = Math.min(1, Math.max(0.4, (Number(options.quality) || 88) / 100));
    if (target === "bmp") {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      return codecs().encodeBmp(
        { width: canvas.width, height: canvas.height, data: imageData.data },
        { background: options.background },
      );
    }
    if (target === "ico") {
      const sizes = codecs().ICO_SIZES.filter((size) => size <= Math.max(canvas.width, canvas.height));
      const chosen = sizes.length > 0 ? sizes : [Math.max(16, Math.min(256, Math.max(canvas.width, canvas.height)))];
      const frames = [];
      for (const size of chosen) {
        const frame = drawToCanvas(canvas, size, size);
        frames.push({ size, data: await blobToBytes(await canvasToBlob(frame, "image/png")) });
      }
      return codecs().encodeIco(frames);
    }
    const mime = CANVAS_MIME[target];
    if (!mime) {
      const error = new Error(`unsupported image target: ${target}`);
      error.code = "TARGET_UNSUPPORTED";
      throw error;
    }
    const blob = await canvasToBlob(canvas, mime, target === "png" ? undefined : quality);
    if (blob.type !== mime && target === "webp") {
      const error = new Error("this browser cannot encode WebP");
      error.code = "TARGET_UNSUPPORTED";
      throw error;
    }
    return blobToBytes(blob);
  }

  // 图片 -> JPEG 字节（供 PDF 内嵌；PDF 只用 DCTDecode）
  async function toJpegBytes(canvas, options = {}) {
    const flattened = flattenCanvas(canvas, options.background);
    const quality = Math.min(1, Math.max(0.4, (Number(options.quality) || 88) / 100));
    return blobToBytes(await canvasToBlob(flattened, "image/jpeg", quality));
  }

  /**
   * 统一入口：File -> 目标格式字节。
   * options: { quality, maxSize, background }
   */
  async function convertImage(file, target, options = {}) {
    const decoded = await decodeImage(file);
    const resized = resizeCanvas(decoded, options.maxSize);
    const needsFlatten = target === "jpg" || target === "bmp" || target === "pdf";
    const prepared = needsFlatten && hasAlpha(resized) ? flattenCanvas(resized, options.background) : resized;
    const warnings = [];
    if (needsFlatten && prepared !== resized) {
      warnings.push({
        code: "ALPHA_COMPOSITED_WHITE",
        messages: {
          zhCN: "目标格式不支持透明通道，透明区域已按所选背景色合成。",
          enUS: "The target format has no alpha channel, so transparent areas were composited onto the chosen background.",
        },
      });
    }
    if (target === "pdf") {
      const jpeg = await toJpegBytes(prepared, options);
      return { canvas: prepared, jpeg, warnings };
    }
    return { canvas: prepared, data: await encodeCanvas(prepared, target, options), warnings };
  }

  offline.imageRuntime = {
    decodeImage,
    resizeCanvas,
    flattenCanvas,
    hasAlpha,
    encodeCanvas,
    toJpegBytes,
    convertImage,
    blobToBytes,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
