// 离线版控制器：队列、目标格式交集、转换编排、结果下载、主题与语言。
// 约束（与桌面版一致的产品红线）：所有用户文本用 DOM API / textContent 生成，禁止 innerHTML；
// 状态图标必须覆盖上传 / 识别 / 转换 / 批量 / 成功 / 失败；长文件名与错误必须可换行。
(function (global) {
  const offline = global.FMOffline || {};
  const formatMap = offline.formatMap;
  const convertText = offline.convertText;
  const imageRuntime = offline.imageRuntime;
  const zipWriter = offline.zipWriter;
  const pdfWriter = offline.pdfWriter;
  const messages = offline.messages;
  const i18nModule = global.FlyingMouseI18n;
  const preferencesModule = global.FlyingMouseConversionPreferences;

  const THEME_STORAGE_KEY = "flyingmouse.theme.v1";
  const THEME_ORDER = ["auto", "light", "dark"];
  const MAX_FILE_BYTES = 256 * 1024 * 1024;
  const MAX_IMAGE_PIXELS = 50 * 1000 * 1000;

  // 状态图标：页面里的 SVG 精灵（自绘几何图形），不引用任何位图
  const STAGE_STATES = ["idle", "upload", "analyzing", "converting", "batch", "success", "error"];

  const state = {
    items: [],
    target: "",
    converting: false,
    preferences: {},
    theme: "auto",
    objectUrls: [],
  };

  const elements = {};
  let i18n = null;
  let toastTimer = 0;
  let mascotTimer = 0;

  function byId(id) {
    return document.getElementById(id);
  }

  // Safari 在 file:// 下读 localStorage 会抛 SecurityError，连 typeof 都会触发 getter，必须包住
  function safeStorage() {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch (error) {
      return null;
    }
  }

  function t(key, params) {
    return i18n ? i18n.t(key, params) : key;
  }

  function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function readStoredTheme() {
    const storage = safeStorage();
    if (!storage) return "auto";
    try {
      const value = storage.getItem(THEME_STORAGE_KEY);
      return THEME_ORDER.includes(value) ? value : "auto";
    } catch (error) {
      return "auto";
    }
  }

  function applyTheme(theme) {
    state.theme = THEME_ORDER.includes(theme) ? theme : "auto";
    document.documentElement.dataset.theme = state.theme;
    elements.themeToggleLabel.textContent = t(`theme.${state.theme}`);
    elements.themeToggle.setAttribute("aria-pressed", state.theme === "dark" ? "true" : "false");
    try {
      const storage = safeStorage();
      if (storage) storage.setItem(THEME_STORAGE_KEY, state.theme);
    } catch (error) {
      // 隐私模式下 localStorage 不可用时忽略即可
    }
  }

  function setStageState(name) {
    const state = STAGE_STATES.includes(name) ? name : "idle";
    elements.stageGlyph.setAttribute("href", `#glyph-${state}`);
    elements.stageArt.dataset.state = state;
  }

  function setStatus(message, type) {
    elements.statusLine.textContent = message;
    elements.statusLine.className = `status-line${type ? ` is-${type}` : ""}`;
  }

  function showToast(message, type) {
    elements.toast.textContent = message;
    elements.toast.className = `toast${type ? ` is-${type}` : ""}`;
    elements.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      elements.toast.hidden = true;
    }, 3200);
  }

  function categoryLabel(category) {
    return t(`category.${category}`);
  }

  function statusLabel(item) {
    if (item.status === "success") {
      // 合并 PDF / 打包 ZIP 时单个文件没有独立产物，只报完成，不报 0 B
      const base = item.result
        ? t("queueStatus.success", { size: formatBytes(item.result.size) })
        : t("queueStatus.done");
      const notes = warningText(item.result ? item.result.warnings : []);
      return notes ? `${base} · ${notes}` : base;
    }
    if (item.status === "error") return item.detail || t("queueStatus.error");
    if (item.status === "converting") return t("queueStatus.converting");
    return t("queueStatus.pending");
  }

  function renderQueue() {
    const nodes = state.items.map((item, index) => {
      const li = document.createElement("li");
      li.className = `queue-item${item.status === "success" ? " is-success" : ""}${item.status === "error" ? " is-error" : ""}`;
      li.dataset.index = String(index);

      const glyph = createTextElement("span", "queue-glyph");
      if (item.thumbnail) {
        const image = document.createElement("img");
        image.className = "queue-thumb";
        image.src = item.thumbnail;
        image.alt = "";
        glyph.append(image);
      } else {
        glyph.textContent = item.extension ? item.extension.toUpperCase() : "?";
      }

      const body = createTextElement("div", "queue-body");
      body.append(createTextElement("p", "queue-name", item.name));
      body.append(createTextElement("p", "queue-meta", t("queue.meta", { category: categoryLabel(item.category), size: formatBytes(item.size) })));
      body.append(createTextElement("p", "queue-status", statusLabel(item)));

      // 转换过程中禁止改队列：转换循环按索引推进，排序/移除会让结果错位
      const actions = createTextElement("div", "queue-actions");
      if (state.items.length > 1) {
        const up = createTextElement("button", "mini-button", "↑");
        up.type = "button";
        up.dataset.move = String(index);
        up.dataset.direction = "up";
        up.title = t("action.moveUp");
        up.disabled = state.converting || index === 0;
        const down = createTextElement("button", "mini-button", "↓");
        down.type = "button";
        down.dataset.move = String(index);
        down.dataset.direction = "down";
        down.title = t("action.moveDown");
        down.disabled = state.converting || index === state.items.length - 1;
        actions.append(up, down);
      }
      const remove = createTextElement("button", "mini-button", "✕");
      remove.type = "button";
      remove.dataset.remove = String(index);
      remove.title = t("action.remove");
      remove.disabled = state.converting;
      actions.append(remove);

      li.append(glyph, body, actions);
      return li;
    });

    elements.queueList.replaceChildren(...nodes);
    elements.queueCounter.textContent = String(state.items.length);
    elements.queueEmpty.hidden = state.items.length > 0;
    elements.workbench.hidden = state.items.length === 0;
  }

  function renderTargets() {
    const extensions = state.items.map((item) => item.extension);
    const targets = formatMap.commonTargets(extensions);
    if (!targets.includes(state.target)) state.target = "";
    if (!state.target && targets.length > 0) {
      const remembered = preferencesModule
        ? preferencesModule.preferredTarget(state.preferences, extensions, targets)
        : null;
      state.target = remembered || targets[0];
    }

    const chips = targets.map((target) => {
      const chip = createTextElement("button", "target-chip", target.toUpperCase());
      chip.type = "button";
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", target === state.target ? "true" : "false");
      chip.dataset.target = target;
      return chip;
    });
    elements.targetGroup.replaceChildren(...chips);

    if (state.items.length === 0) elements.targetNote.textContent = t("target.empty");
    else if (targets.length <= 1) elements.targetNote.textContent = t("target.none");
    else elements.targetNote.textContent = t("target.mixed");

    syncOptionPanels();
    elements.convertButton.disabled = state.converting || state.items.length === 0 || !state.target;
  }

  function syncOptionPanels() {
    const categories = new Set(state.items.map((item) => item.category));
    const target = state.target;
    const imageTarget = ["png", "jpg", "webp", "bmp", "ico", "pdf"].includes(target);
    elements.imageOptions.hidden = !(categories.has("image") && imageTarget);
    elements.pdfOptions.hidden = !(categories.has("image") && target === "pdf");
    elements.textOptions.hidden = !(["csv", "tsv", "json", "md", "html", "txt", "epub", "docx"].includes(target)
      && (categories.has("text") || categories.has("table") || categories.has("data")));
    elements.alphaBackgroundField.hidden = !["jpg", "bmp", "pdf"].includes(target);
    elements.ebookTitleField.hidden = target !== "epub" && target !== "docx";
  }

  function renderResults() {
    const finished = state.items.filter((item) => item.status === "success" && item.result);
    const extras = state.extraResults || [];
    const all = finished.map((item) => item.result).concat(extras);
    const nodes = all.map((result, index) => {
      const li = document.createElement("li");
      li.className = "result-item";
      const body = createTextElement("div", "result-body");
      body.append(createTextElement("p", "result-name", result.name));
      body.append(createTextElement("p", "result-meta", formatBytes(result.size)));
      const actions = createTextElement("div", "result-actions");
      const save = createTextElement("button", "ghost-button", t("action.download"));
      save.type = "button";
      save.dataset.download = String(index);
      actions.append(save);
      if (supportsSavePicker()) {
        const saveAs = createTextElement("button", "ghost-button", t("action.saveAs"));
        saveAs.type = "button";
        saveAs.dataset.saveAs = String(index);
        actions.append(saveAs);
      }
      li.append(body, actions);
      return li;
    });
    elements.resultList.replaceChildren(...nodes);
    elements.resultsCounter.textContent = String(all.length);
    elements.resultsCard.hidden = all.length === 0;
    elements.downloadAllButton.hidden = all.length < 2;
    state.allResults = all;
  }

  function refreshLanguage() {
    document.documentElement.lang = i18n.language;
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = t(element.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((element) => {
      element.setAttribute("aria-label", t(element.dataset.i18nAria));
    });
    elements.languageSelect.value = i18n.language;
    elements.themeToggleLabel.textContent = t(`theme.${state.theme}`);
    if (offline.buildInfo) elements.buildLine.textContent = t("footer.build", { version: offline.buildInfo.version });
    renderQueue();
    renderTargets();
    renderResults();
    if (!state.converting) {
      setStatus(state.items.length === 0 ? t("status.idle") : t("status.ready", { count: state.items.length }));
    }
  }

  function makeItem(file) {
    const extension = formatMap.extensionOf(file.name);
    return {
      file,
      name: file.name,
      size: file.size,
      extension,
      category: formatMap.categoryOf(extension),
      status: "pending",
      detail: "",
      result: null,
      thumbnail: "",
    };
  }

  function attachThumbnail(item) {
    if (item.category !== "image" || item.size > 24 * 1024 * 1024) return;
    const url = URL.createObjectURL(item.file);
    state.objectUrls.push(url);
    item.thumbnail = url;
  }

  function addFiles(fileList) {
    if (state.converting) return;
    const files = Array.from(fileList || []).filter((file) => file && file.size >= 0);
    if (files.length === 0) return;
    let rejected = 0;
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        rejected += 1;
        continue;
      }
      const item = makeItem(file);
      attachThumbnail(item);
      state.items.push(item);
    }
    if (rejected > 0) {
      showToast(t("error.tooLarge", { size: formatBytes(MAX_FILE_BYTES), limit: formatBytes(MAX_FILE_BYTES) }), "error");
    }
    setStageState(state.items.length > 1 ? "batch" : "analyzing");
    renderQueue();
    renderTargets();
    renderResults();
    setStatus(t("status.ready", { count: state.items.length }));
    // 识别动作只是一个短暂的状态；转换开始后由 convertAll 接管，避免把成功/失败状态覆盖掉
    if (mascotTimer) clearTimeout(mascotTimer);
    mascotTimer = window.setTimeout(() => {
      mascotTimer = 0;
      if (!state.converting) setStageState(state.items.length > 1 ? "batch" : "idle");
    }, 500);
  }

  function clearQueue() {
    if (state.converting) return;
    if (mascotTimer) {
      clearTimeout(mascotTimer);
      mascotTimer = 0;
    }
    for (const url of state.objectUrls) URL.revokeObjectURL(url);
    state.objectUrls = [];
    state.items = [];
    state.extraResults = [];
    state.target = "";
    renderQueue();
    renderTargets();
    renderResults();
    setStageState("upload");
    setStatus(t("status.idle"));
    showToast(t("toast.cleared"));
  }

  // 中文 Windows 里 Excel 导出的 CSV / TXT 常见 GBK 编码：UTF-8 解出替换字符时回退 GBK
  async function readFileAsText(file) {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const utf8 = new TextDecoder("utf-8").decode(buffer);
    if (!utf8.includes("\uFFFD")) return utf8;
    try {
      const gbk = new TextDecoder("gbk").decode(buffer);
      if (!gbk.includes("\uFFFD")) return gbk;
    } catch (error) {
      // 浏览器不支持 gbk 时保持 UTF-8 结果
    }
    return utf8;
  }

  function textOptions() {
    const raw = elements.csvDelimiter.value;
    return {
      delimiter: raw === "\\t" ? "\t" : raw,
      bom: elements.csvBom.checked,
      title: elements.ebookTitle.value.trim(),
    };
  }

  function imageOptions() {
    return {
      quality: Number(elements.imageQuality.value) || 88,
      maxSize: Number(elements.imageMaxSize.value) || 0,
      background: elements.alphaBackground.value,
    };
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    return new TextEncoder().encode(String(data));
  }

  function makeResult(name, bytes, extension, warnings) {
    const blob = new Blob([bytes], { type: formatMap.mimeTypeFor(extension) });
    return { name, blob, size: blob.size, warnings: warnings || [] };
  }

  // 警告是 { code, messages: { zhCN, enUS } }，与桌面版同结构
  function warningText(warnings) {
    if (!warnings || warnings.length === 0) return "";
    const key = i18n && i18n.language === "en-US" ? "enUS" : "zhCN";
    return warnings.map((warning) => (warning.messages ? warning.messages[key] : warning.code)).join(" ");
  }

  async function convertOne(item, target) {
    if (item.category === "image") {
      const converted = await imageRuntime.convertImage(item.file, target, imageOptions());
      if (converted.canvas && converted.canvas.width * converted.canvas.height > MAX_IMAGE_PIXELS) {
        const error = new Error("image exceeds the 50MP offline limit");
        error.code = "IMAGE_TOO_LARGE";
        throw error;
      }
      if (target === "pdf") {
        const pdf = pdfWriter.createImagePdf([{ data: converted.jpeg }], {
          paper: elements.pdfPaper.value,
          margin: Number(elements.pdfMargin.value) || 0,
        });
        return makeResult(formatMap.outputNameFor(item.name, "pdf"), pdf, "pdf", converted.warnings);
      }
      return makeResult(formatMap.outputNameFor(item.name, target), converted.data, target, converted.warnings);
    }
    const source = item.extension || "txt";
    const raw = await readFileAsText(item.file);
    const options = textOptions();
    if (!options.title) options.title = formatMap.safeBaseName(item.name);
    const converted = await convertText.convertTextDocument(raw, source, target, options);
    return makeResult(formatMap.outputNameFor(item.name, target), toBytes(converted.data), target, converted.warnings);
  }

  async function convertQueueToZip(items) {
    const entries = [];
    const used = new Set();
    for (const item of items) {
      let name = formatMap.sanitizeFileName(item.name) || "file";
      let suffix = 1;
      while (used.has(name)) {
        suffix += 1;
        name = `${formatMap.safeBaseName(item.name)}-${suffix}.${formatMap.extensionOf(item.name) || "bin"}`;
      }
      used.add(name);
      entries.push({ name, data: new Uint8Array(await item.file.arrayBuffer()) });
    }
    const bytes = await zipWriter.createZipCompressed(entries);
    const name = items.length === 1
      ? formatMap.outputNameFor(items[0].name, "zip")
      : `formatdeck-${items.length}-files.zip`;
    return makeResult(name, bytes, "zip");
  }

  async function convertMergedPdf(items) {
    const options = imageOptions();
    const pages = [];
    for (const item of items) {
      const converted = await imageRuntime.convertImage(item.file, "pdf", options);
      pages.push({ data: converted.jpeg });
    }
    const pdf = pdfWriter.createImagePdf(pages, {
      paper: elements.pdfPaper.value,
      margin: Number(elements.pdfMargin.value) || 0,
    });
    return makeResult(formatMap.outputNameFor(items[0].name, "pdf"), pdf, "pdf");
  }

  // 整批失败（打包 / 合并 PDF 这种一次成一个产物的路径）时，把错误落到每个文件上
  function markBatchFailed(items, error) {
    const detail = t("error.convert", { message: error && error.message ? error.message : String(error) });
    for (const item of items) {
      item.status = "error";
      item.result = null;
      item.detail = detail;
    }
  }

  async function convertAll() {
    if (state.converting || state.items.length === 0) return;
    if (!state.target) {
      showToast(t("error.noTarget"), "error");
      return;
    }
    state.converting = true;
    if (mascotTimer) {
      clearTimeout(mascotTimer);
      mascotTimer = 0;
    }
    state.extraResults = [];
    elements.convertButton.disabled = true;
    elements.convertButton.textContent = t("action.converting");
    elements.clearButton.disabled = true;
    elements.addMoreButton.disabled = true;
    setStageState(state.items.length > 1 ? "batch" : "converting");

    const target = state.target;
    const mergePdf = target === "pdf" && elements.pdfMerge.checked && state.items.filter((item) => item.category === "image").length > 1;

    try {
      if (target === "zip") {
        for (const item of state.items) {
          item.status = "converting";
          item.detail = "";
        }
        renderQueue();
        setStatus(t("status.converting", { current: 1, total: 1, name: state.items[0].name }));
        try {
          const result = await convertQueueToZip(state.items);
          for (const item of state.items) {
            item.status = "success";
            item.result = null;
          }
          state.extraResults = [result];
        } catch (error) {
          markBatchFailed(state.items, error);
        }
      } else if (mergePdf) {
        const images = state.items.filter((item) => item.category === "image");
        setStatus(t("status.converting", { current: 1, total: 1, name: images[0].name }));
        for (const item of images) {
          item.status = "converting";
        }
        renderQueue();
        try {
          const result = await convertMergedPdf(images);
          for (const item of images) {
            item.status = "success";
            item.result = null;
          }
          state.extraResults = [result];
          showToast(t("toast.merged", { count: images.length }));
        } catch (error) {
          markBatchFailed(images, error);
        }
      } else {
        let index = 0;
        for (const item of state.items) {
          index += 1;
          item.status = "converting";
          item.detail = "";
          renderQueue();
          setStatus(t("status.converting", { current: index, total: state.items.length, name: item.name }));
          try {
            item.result = await convertOne(item, target);
            item.status = "success";
          } catch (error) {
            item.status = "error";
            item.result = null;
            item.detail = t("error.convert", { message: error && error.message ? error.message : String(error) });
          }
          renderQueue();
        }
      }
    } finally {
      state.converting = false;
      elements.clearButton.disabled = false;
      elements.addMoreButton.disabled = false;
      elements.convertButton.textContent = t("action.convert");
      elements.convertButton.disabled = state.items.length === 0 || !state.target;
    }

    const failed = state.items.filter((item) => item.status === "error").length;
    const success = state.items.length - failed;
    if (failed === 0) {
      setStageState("success");
      setStatus(t("status.done", { count: success }), "success");
    } else if (success === 0) {
      setStageState("error");
      setStatus(t("status.failedAll"), "error");
    } else {
      setStageState("error");
      setStatus(t("status.partial", { success, failed }), "error");
    }

    renderQueue();
    renderResults();
  }

  function downloadWithAnchor(name, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function supportsSavePicker() {
    return typeof window.showSaveFilePicker === "function";
  }

  // 「另存为」走文件选择器：可以自己选目录，也不会被浏览器改名（部分环境会丢掉 download 属性里的中文名）。
  async function saveBlobAs(name, blob) {
    if (!supportsSavePicker()) {
      downloadWithAnchor(name, blob);
      return;
    }
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      if (error && error.name === "AbortError") return;
      downloadWithAnchor(name, blob);
    }
  }

  function saveBlob(name, blob) {
    downloadWithAnchor(name, blob);
  }

  // 同名结果（不同目录的同名文件）必须改名，否则 ZIP 里会出现重复条目，解压时互相覆盖
  function uniqueName(name, used) {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let suffix = 2;
    let candidate = `${stem}-${suffix}${extension}`;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${stem}-${suffix}${extension}`;
    }
    used.add(candidate);
    return candidate;
  }

  async function downloadAll() {
    const results = state.allResults || [];
    if (results.length === 0) return;
    try {
      const used = new Set();
      const entries = [];
      for (const result of results) {
        entries.push({ name: uniqueName(result.name, used), data: new Uint8Array(await result.blob.arrayBuffer()) });
      }
      const bytes = await zipWriter.createZipCompressed(entries);
      saveBlob("formatdeck-offline.zip", new Blob([bytes], { type: "application/zip" }));
    } catch (error) {
      showToast(t("error.convert", { message: error && error.message ? error.message : String(error) }), "error");
    }
  }

  // 与桌面版一致：用户手动选择目标格式时按源扩展名记忆，下次同类文件默认这个目标
  function rememberTarget() {
    if (!preferencesModule || !state.target || state.items.length === 0) return;
    state.preferences = preferencesModule.rememberTarget(
      state.preferences,
      state.items.map((item) => item.extension),
      state.target,
    );
    try {
      const storage = safeStorage();
      if (storage) storage.setItem(preferencesModule.STORAGE_KEY, JSON.stringify(state.preferences));
    } catch (error) {
      // 隐私模式下存不了偏好，不影响转换
    }
  }

  function moveItem(index, direction) {
    if (state.converting) return;
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= state.items.length) return;
    const [item] = state.items.splice(index, 1);
    state.items.splice(target, 0, item);
    renderQueue();
  }

  function removeItem(index) {
    if (state.converting) return;
    const [removed] = state.items.splice(index, 1);
    if (removed && removed.thumbnail) {
      URL.revokeObjectURL(removed.thumbnail);
      state.objectUrls = state.objectUrls.filter((url) => url !== removed.thumbnail);
    }
    renderQueue();
    renderTargets();
    renderResults();
    if (state.items.length === 0) {
      setStageState("upload");
      setStatus(t("status.idle"));
    }
  }

  function bindEvents() {
    elements.dropZone.addEventListener("click", () => elements.fileInput.click());
    elements.addMoreButton.addEventListener("click", () => elements.fileInput.click());
    elements.fileInput.addEventListener("change", () => {
      addFiles(elements.fileInput.files);
      elements.fileInput.value = "";
    });
    elements.clearButton.addEventListener("click", clearQueue);
    elements.convertButton.addEventListener("click", convertAll);
    elements.downloadAllButton.addEventListener("click", downloadAll);

    ["dragenter", "dragover"].forEach((type) => {
      elements.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        elements.dropZone.classList.add("dragging");
        setStageState("upload");
      });
    });
    ["dragleave", "dragend"].forEach((type) => {
      elements.dropZone.addEventListener(type, () => elements.dropZone.classList.remove("dragging"));
    });
    elements.dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("dragging");
      addFiles(event.dataTransfer ? event.dataTransfer.files : null);
    });
    document.addEventListener("dragover", (event) => event.preventDefault());
    document.addEventListener("drop", (event) => event.preventDefault());
    document.addEventListener("paste", (event) => {
      const files = event.clipboardData ? Array.from(event.clipboardData.files || []) : [];
      if (files.length > 0) addFiles(files);
    });

    elements.targetGroup.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-target]");
      if (!chip) return;
      state.target = chip.dataset.target;
      rememberTarget();
      renderTargets();
    });

    elements.queueList.addEventListener("click", (event) => {
      const move = event.target.closest("[data-move]");
      if (move) {
        moveItem(Number(move.dataset.move), move.dataset.direction);
        return;
      }
      const remove = event.target.closest("[data-remove]");
      if (remove) removeItem(Number(remove.dataset.remove));
    });

    elements.resultList.addEventListener("click", (event) => {
      const saveAsButton = event.target.closest("[data-save-as]");
      if (saveAsButton) {
        const target = (state.allResults || [])[Number(saveAsButton.dataset.saveAs)];
        if (target) saveBlobAs(target.name, target.blob);
        return;
      }
      const button = event.target.closest("[data-download]");
      if (!button) return;
      const result = (state.allResults || [])[Number(button.dataset.download)];
      if (result) saveBlob(result.name, result.blob);
    });

    elements.imageQuality.addEventListener("input", () => {
      elements.imageQualityValue.textContent = elements.imageQuality.value;
    });

    elements.themeToggle.addEventListener("click", () => {
      const next = THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length];
      applyTheme(next);
    });

    elements.languageSelect.addEventListener("change", () => {
      i18n.setLanguage(elements.languageSelect.value);
      refreshLanguage();
    });
  }

  function collectElements() {
    const ids = [
      "stageArt", "stageGlyph", "dropZone", "fileInput", "workbench", "queueList", "queueCounter", "queueEmpty",
      "addMoreButton", "clearButton", "targetGroup", "targetNote", "imageOptions", "pdfOptions", "textOptions",
      "imageQuality", "imageQualityValue", "imageMaxSize", "alphaBackground", "alphaBackgroundField", "pdfPaper",
      "pdfMargin", "pdfMerge", "csvDelimiter", "csvBom", "ebookTitle", "ebookTitleField", "convertButton",
      "statusLine", "resultsCard", "resultList", "resultsCounter", "downloadAllButton", "themeToggle",
      "themeToggleLabel", "languageSelect", "toast", "buildLine",
    ];
    for (const id of ids) elements[id] = byId(id);
  }

  function initialize() {
    collectElements();
    const storage = safeStorage();
    i18n = i18nModule.createI18n({
      storage,
      systemLanguage: navigator.language,
      messages,
    });
    if (preferencesModule) state.preferences = preferencesModule.readPreferences(storage);
    applyTheme(readStoredTheme());
    setStageState("upload");
    bindEvents();
    refreshLanguage();
    renderResults();
    if (offline.buildInfo) {
      elements.buildLine.textContent = t("footer.build", { version: offline.buildInfo.version });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
  else initialize();
})(typeof globalThis !== "undefined" ? globalThis : this);
