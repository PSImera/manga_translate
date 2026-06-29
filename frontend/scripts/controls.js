"use strict";
// [module] toolbar controls initialization, mask defaults, language dropdowns
// effective mask detection parameters for a single bubble, ready to send to the backend
// (percentages are converted to fractions 0..1)
function maskFields(b) {
  return {
    mask_expand: bubbleParam(b, "maskExpand") / 100,
    grow: bubbleParam(b, "grow"),
    inset: bubbleParam(b, "inset"),
    min_area: bubbleParam(b, "minArea"),
    center_priority: !!bubbleParam(b, "centerPriority"),
    center_radius: bubbleParam(b, "centerRadius") / 100,
    // inpaint context as a fraction of bubble size (same as the dashed expand border);
    // the inpainter uses it, /mask/boxes preview ignores it (no inpaint there)
    pad: bubbleParam(b, "showExpand") ? bubbleParam(b, "inpaintPad") / 100 : 0,
  };
}

// effective render style for a bubble: per-bubble override from the texts panel, or global
// default from the toolbar. t = page.bubbleTexts[i].
function styleFields(t) {
  const s = state.settings;
  // margin is stored in percent (per side); the backend receives it as a fraction 0..1
  const marginPct = (t && t.margin != null) ? t.margin : s.defaultMargin;
  return {
    font: (t && t.font) || s.defaultFont || null,
    font_weight: (t && t.font_weight) || s.defaultFontWeight || null,
    font_italic: (t && t.font_italic != null) ? !!t.font_italic : !!(s.defaultFontItalic),
    font_size: (t && t.font_size != null) ? t.font_size : (s.defaultFontSize || 36),
    margin: (marginPct != null ? marginPct : 8) / 100,
    align: (t && t.align) || s.defaultAlign || "center",
    valign: (t && t.valign) || s.defaultValign || "middle",
    slant: (t && t.slant) || 0,   // whole-line slant in degrees (per-bubble only)
    vertical: (t && t.vertical != null) ? !!t.vertical : !!(s.defaultVertical),
    color: (t && t.color) || s.textColor || null,
    stroke: (t && t.stroke != null) ? !!t.stroke : !!(s.defaultStroke),
    stroke_width: (t && t.stroke_width != null) ? t.stroke_width : (s.defaultStrokeWidth ?? 2),
    stroke_color: (t && t.stroke_color) || s.defaultStrokeColor || "#ffffff",
  };
}

// copy per-bubble style overrides into an updated text object (translation response doesn't carry them).
// ?? null preserves valid 0 values (margin 0%, slant 0 are stored as null/number).
function carryStyle(prev) {
  prev = prev || {};
  return {
    font: prev.font ?? null,
    font_weight: prev.font_weight ?? null,
    font_italic: prev.font_italic ?? null,
    font_size: prev.font_size ?? null,
    margin: prev.margin ?? null,
    align: prev.align ?? null,
    valign: prev.valign ?? null,
    slant: prev.slant ?? null,
    vertical: prev.vertical ?? null,
    color: prev.color ?? null,
    stroke: prev.stroke ?? null,
    stroke_width: prev.stroke_width ?? null,
    stroke_color: prev.stroke_color ?? null,
  };
}

function updateContextState() {
  const on = state.settings.useContext;
  document.querySelectorAll(".ctx-sub").forEach((r) => r.classList.toggle("ctl-disabled", !on));
}

// «Center radius» only makes sense when «center priority» is on — disable otherwise
// (global control follows the shared setting; panel row follows the effective frame value).
function setCtlDisabled(input, off) {
  if (!input) return;
  input.disabled = off;
  const lab = input.closest('[data-ctl="center-radius"]');
  if (lab) lab.classList.toggle("ctl-disabled", off);
}
function updateCenterRadiusState() {
  setCtlDisabled(el.centerRadius, !state.settings.centerPriority);
  if (el.bubblePanel && !el.bubblePanel.classList.contains("collapsed")) {
    const b = selectedBubble();
    setCtlDisabled(el.bpCenterRadius, b ? !bubbleParam(b, "centerPriority") : false);
  }
}

// refresh one global mask detection control to match the current setting value
function refreshGlobalMaskControl(key) {
  const s = state.settings;
  if (key === "maskExpand") { el.maskExpand.value = s.maskExpand; el.maskExpandOut.textContent = `${s.maskExpand}%`; }
  else if (key === "grow") { el.grow.value = s.grow; el.growOut.textContent = `${s.grow}px`; }
  else if (key === "inset") { el.inset.value = s.inset; el.insetOut.textContent = `${s.inset}px`; }
  else if (key === "minArea") { el.minArea.value = s.minArea; el.minAreaOut.textContent = `${s.minArea}`; }
  else if (key === "centerPriority") el.centerPriority.checked = s.centerPriority;
  else if (key === "centerRadius") { el.centerRadius.value = s.centerRadius; el.centerRadiusOut.textContent = `${s.centerRadius}%`; }
}

// ↺ on global mask params — reset to factory default; «?» shows tooltip (title)
function initMaskDefaults() {
  document.querySelectorAll(".md-reset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.reset;
      if (!(key in MASK_DEFAULTS)) return;
      state.settings[key] = MASK_DEFAULTS[key];
      refreshGlobalMaskControl(key);
      saveSettings();
      if (key === "centerPriority") updateCenterRadiusState();
      renderExpand();
      scheduleMaskPreview(state.pages[state.active]);
      syncBubblePanel();
    });
  });
  applyTooltips();
}

// =====================================================================
// controls initialization
// =====================================================================
async function initLamaModelSelect() {
  try {
    const models = await fetch("/lama-models").then(r => r.json());
    el.lamaModel.innerHTML = models.map(m =>
      `<option value="${m.name}">${m.label}</option>`
    ).join("");
    el.lamaModel.value = state.settings.lamaModel;
  } catch (_) {}
}

function initControls() {
  const s = state.settings;
  initLangSelect();
  initLamaModelSelect();
  el.conf.value = s.conf; el.confOut.textContent = (+s.conf).toFixed(2);
  el.maskExpand.value = s.maskExpand; el.maskExpandOut.textContent = `${s.maskExpand}%`;
  el.showExpand.classList.toggle("active", s.showExpand);
  el.inpaintPad.value = s.inpaintPad; el.inpaintPadOut.textContent = `${s.inpaintPad}%`;
  el.inpaintPad.disabled = !s.showExpand;
  // «⬚ Frames» set: restore expanded/collapsed state
  el.frameTools.classList.toggle("hidden", !s.showFrames);
  el.frameToggle.classList.toggle("active", s.showFrames);
  // mask overlay = «🖌 Mask» set expanded: restore in sync
  el.maskTools.classList.toggle("hidden", !s.showMask);
  el.maskToggle.classList.toggle("active", s.showMask);
  el.grow.value = s.grow; el.growOut.textContent = `${s.grow}px`;
  el.inset.value = s.inset; el.insetOut.textContent = `${s.inset}px`;
  el.minArea.value = s.minArea; el.minAreaOut.textContent = `${s.minArea}`;
  el.centerPriority.checked = s.centerPriority;
  el.centerRadius.value = s.centerRadius; el.centerRadiusOut.textContent = `${s.centerRadius}%`;
  updateCenterRadiusState();

  // global color buttons trigger the HSV picker.
  // frame color = default for new frames (existing frames are not repainted); mask color is global.
  el.frameColorBtn.style.background = s.frameColor;
  el.frameColorBtn.addEventListener("click", () => {
    openColorPicker(el.frameColorBtn, s.frameColor, (c) => {
      s.frameColor = c; el.frameColorBtn.style.background = c; saveSettings();
      refreshBubbleColors(); renderExpand(); syncBubblePanel();
    });
  });
  el.maskColorBtn.style.background = s.maskColor;
  el.maskColorBtn.addEventListener("click", () => {
    openColorPicker(el.maskColorBtn, s.maskColor, (c) => {
      s.maskColor = c; el.maskColorBtn.style.background = c; saveSettings(); renderMask();
    });
  });
  setupFontTools();
  // mask opacity — shared between auto-detection and brush (applied to the overlay)
  el.maskOpacity.value = s.maskOpacity; el.maskOpacityOut.textContent = `${s.maskOpacity}`;
  el.maskOpacity.addEventListener("input", () => {
    s.maskOpacity = +el.maskOpacity.value; el.maskOpacityOut.textContent = `${s.maskOpacity}`;
    saveSettings(); applyMaskOpacity();   // node property only, no tint rebuild (4K)
  });

  Konva.dragButtons = [0]; // drag frames with LMB only (middle button pans the stage)
  initColorPicker();
  initBubblePanel();
  initBrush();
  initMaskDefaults();

  el.conf.addEventListener("input", () => {
    s.conf = +el.conf.value; el.confOut.textContent = s.conf.toFixed(2); saveSettings();
  });
  // Global controls are defaults for frames. They affect every frame where the parameter is NOT
  // individually overridden (inherited). Editing a default therefore redraws previews/frames
  // live and updates the open panel of the selected frame.
  el.lamaModel.addEventListener("change", () => {
    s.lamaModel = el.lamaModel.value; saveSettings();
  });
  el.maskExpand.addEventListener("input", () => {
    s.maskExpand = +el.maskExpand.value; el.maskExpandOut.textContent = `${s.maskExpand}%`;
    saveSettings(); renderExpand(); scheduleMaskPreview(state.pages[state.active]); syncBubblePanel();
  });
  el.showExpand.addEventListener("click", () => {
    s.showExpand = !s.showExpand; el.showExpand.classList.toggle("active", s.showExpand);
    el.inpaintPad.disabled = !s.showExpand;
    saveSettings(); renderExpand(); syncBubblePanel();
  });
  el.inpaintPad.addEventListener("input", () => {
    s.inpaintPad = +el.inpaintPad.value; el.inpaintPadOut.textContent = `${s.inpaintPad}%`;
    saveSettings(); renderExpand(); syncBubblePanel();
  });

  // mask detection params: editing a default triggers mask preview refresh for all frames
  // that inherit it, and syncs the open bubble panel.
  el.grow.addEventListener("input", () => {
    s.grow = +el.grow.value; el.growOut.textContent = `${s.grow}px`; saveSettings();
    renderExpand(); scheduleMaskPreview(state.pages[state.active]); syncBubblePanel();
  });
  el.inset.addEventListener("input", () => {
    s.inset = +el.inset.value; el.insetOut.textContent = `${s.inset}px`; saveSettings();
    scheduleMaskPreview(state.pages[state.active]); syncBubblePanel();
  });
  el.minArea.addEventListener("input", () => {
    s.minArea = +el.minArea.value; el.minAreaOut.textContent = `${s.minArea}`; saveSettings();
    scheduleMaskPreview(state.pages[state.active]); syncBubblePanel();
  });
  el.centerPriority.addEventListener("change", () => {
    s.centerPriority = el.centerPriority.checked; saveSettings();
    updateCenterRadiusState();
    scheduleMaskPreview(state.pages[state.active]); syncBubblePanel();
  });
  el.centerRadius.addEventListener("input", () => {
    s.centerRadius = +el.centerRadius.value; el.centerRadiusOut.textContent = `${s.centerRadius}%`;
    saveSettings(); scheduleMaskPreview(state.pages[state.active]); syncBubblePanel();
  });

  el.ctxPass.checked = s.useContext;
  el.ctxWindow.value = s.contextWindow;
  el.ctxPages.value = s.contextPages;
  el.ctxBubbles.value = s.contextBubbles;
  updateContextState();

  el.ctxPass.addEventListener("change", () => {
    s.useContext = el.ctxPass.checked; saveSettings(); updateContextState();
  });
  const clampInt = (v, min, max) => Math.max(min, Math.min(max, Math.floor(+v) || 0));
  el.ctxWindow.addEventListener("change", () => {
    s.contextWindow = clampInt(el.ctxWindow.value, 0, 20);
    el.ctxWindow.value = s.contextWindow; saveSettings();
  });
  el.ctxPages.addEventListener("change", () => {
    s.contextPages = clampInt(el.ctxPages.value, 0, 5);
    el.ctxPages.value = s.contextPages; saveSettings();
  });
  el.ctxBubbles.addEventListener("change", () => {
    s.contextBubbles = clampInt(el.ctxBubbles.value, 0, 30);
    el.ctxBubbles.value = s.contextBubbles; saveSettings();
  });

  el.fileInput.addEventListener("change", onFiles);
  el.clearAll.addEventListener("click", (e) => { e.stopPropagation(); toggleClearConfirm(); });
  el.clearCancel.addEventListener("click", closeClearConfirm);
  el.clearConfirmBtn.addEventListener("click", () => { closeClearConfirm(); clearAllPages(); });
  document.addEventListener("click", (e) => {
    if (!el.clearConfirm.classList.contains("hidden") &&
        !e.target.closest("#clear-confirm") && e.target !== el.clearAll) closeClearConfirm();
  });
  // «⬚ Frames» — toggle for the frame control set (the «🖌 Mask» set is nested inside it)
  el.frameToggle.addEventListener("click", () => setFramesOpen(el.frameTools.classList.contains("hidden")));
  el.addModeBtn.addEventListener("click", toggleAddMode);
  el.delBtn.addEventListener("click", deleteSelected);
  el.redetect.addEventListener("click", redetectActive);
  el.orderStrategy.addEventListener("change", onStrategyChange);
  el.orderIndividual.addEventListener("change", onIndividualToggle);
  el.orderNumber.addEventListener("click", toggleNumberMode);
  el.translatePage.addEventListener("click", async () => {
    state.cancel = false;
    const ctx = state.settings.useContext ? prevPagesContext(state.active) : null;
    const ok = await translateOne(state.pages[state.active], ctx);
    if (ok) setDoneStatus("translation");
  });
  el.translateBubble.addEventListener("click", translateSelected);
  el.translateAll.addEventListener("click", translateAll);
  el.download.addEventListener("click", downloadActive);
  el.downloadAll.addEventListener("click", downloadAllZip);
  el.downloadPdf.addEventListener("click", downloadAllPdf);
  el.prev.addEventListener("click", () => gotoPage(state.active - 1));
  el.next.addEventListener("click", () => gotoPage(state.active + 1));
  el.showOriginal.addEventListener("click", () => setViewMode("original"));
  el.showResult.addEventListener("click", () => setViewMode("result"));
  el.zoomIn.addEventListener("click", () => setZoom(zoom * 1.25));
  el.zoomOut.addEventListener("click", () => setZoom(zoom / 1.25));
  el.zoomReset.addEventListener("click", () => setZoom(1));
  el.textsToggle.addEventListener("click", () => {
    state.settings.textsCollapsed = !state.settings.textsCollapsed;
    saveSettings();
    applyTextsCollapsed();
  });
  applyTextsCollapsed();
  el.thumbsToggle.addEventListener("click", () => {
    state.settings.queueCollapsed = !state.settings.queueCollapsed;
    saveSettings();
    applyQueueCollapsed();
    buildStage();   // recalculate canvas height for the gained/lost space
  });
  applyQueueCollapsed();
  setupZoomPan();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Delete" && state.selected) deleteSelected();
    if (e.key === "ArrowLeft") gotoPage(state.active - 1);
    if (e.key === "ArrowRight") gotoPage(state.active + 1);
  });

  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(buildStage, 150); });
}

// Languages for the backend: source (OCR) and target (translation).
function transLangs() {
  return { ocr_lang: state.settings.sourceLang, target_lang: state.settings.targetLang };
}

// Custom language dropdown with flag images. Used for both source and target:
// codes = allowed codes; getCode/setCode = read/write the current setting.
function setupLangDropdown(btn, menu, codes, getCode, setCode) {
  const item = langOptionHtml;
  const current = () => (codes.includes(getCode()) ? getCode() : codes[0]);
  const renderBtn = () => { btn.innerHTML = item(current()) + `<span class="caret">▾</span>`; };
  const markActive = () => menu.querySelectorAll(".lang-opt").forEach(
    (o) => o.classList.toggle("active", o.dataset.code === current()));
  const close = () => { menu.classList.add("hidden"); btn.setAttribute("aria-expanded", "false"); };
  const open = () => { menu.classList.remove("hidden"); btn.setAttribute("aria-expanded", "true"); };

  menu.innerHTML = codes.map(
    (c) => `<button type="button" class="lang-opt" role="option" data-code="${c}">${item(c)}</button>`
  ).join("");
  renderBtn();
  markActive();

  menu.querySelectorAll(".lang-opt").forEach((opt) => {
    opt.addEventListener("click", () => {
      setCode(opt.dataset.code);
      saveSettings();
      renderBtn();
      markActive();
      close();
    });
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("hidden")) open(); else close();
  });
  const containerSel = `#${menu.parentElement.id}`;
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !e.target.closest(containerSel)) close();
  });
}

function initLangSelect() {
  const s = state.settings;
  // source language change switches the OCR engine → update mask preview and inherited values
  setupLangDropdown(el.srcLangBtn, el.srcLangMenu, SOURCE_LANGS,
    () => s.sourceLang, (c) => {
      s.sourceLang = c;
      resortAllReadingOrder();   // reading direction depends on language → re-sort all pages
      scheduleMaskPreview(state.pages[state.active]);
    });
  setupLangDropdown(el.langBtn, el.langMenu, TARGET_LANGS,
    () => s.targetLang, (c) => {
      s.targetLang = c;
      // if the current global font is unset or doesn't support the new language — fall back to the language default
      const avail = fontsForLang(c);
      if (!s.defaultFont || !avail.some(f => f.name === s.defaultFont)) {
        const fallback = (state.fontDefaults && state.fontDefaults[c]) || (avail[0] && avail[0].name) || "";
        if (fallback !== s.defaultFont) {
          s.defaultFont = fallback;
          s.defaultFontWeight = "Regular";
          s.defaultFontItalic = false;
        }
      }
      // available fonts are filtered by target language → update toolbar and texts panel
      populateGlobalFont();
      if (state.pages[state.active]) renderTexts();
    });
}

