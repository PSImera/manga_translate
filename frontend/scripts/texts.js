"use strict";
// [module] right-side texts/translation panel + render fonts

// =====================================================================
// font filtering helpers by target lang
// =====================================================================

// Check variant coverage via variant_langs (no data → assume supported)
function _variantSupportsLang(fInfo, variantName, lang) {
  if (!lang || !fInfo) return true;
  const vl = fInfo.variant_langs;
  if (!vl || !(variantName in vl)) return true;
  return vl[variantName].includes(lang);
}

// A weight is supported if its non-italic variant covers the target lang
function _weightSupportsLang(fInfo, weight, lang) {
  if (!lang || !fInfo) return true;
  const variantName = (weight === "Regular" || weight === "") ? "Regular" : weight;
  return _variantSupportsLang(fInfo, variantName, lang);
}

// Does the font have an italic variant that covers the target lang?
function _hasItalicForLang(fInfo, lang) {
  if (!fInfo || !fInfo.has_italic) return false;
  if (!lang) return true;
  return (fInfo.variants || []).some(v => {
    const isItalic = v.endsWith(" Italic") || v === "Italic";
    if (!isItalic) return false;
    return _variantSupportsLang(fInfo, v, lang);
  });
}

// =====================================================================
// bubble texts
// =====================================================================
function applyTextsCollapsed() {
  const collapsed = state.settings.textsCollapsed;
  el.textsPanel.classList.toggle("collapsed", collapsed);
  el.textsToggle.textContent = collapsed ? "‹" : "›";
}

let _openTextIdx = -1;
let _textsPageId = null;

function hasStyleOverride(b) {
  return !!(b.font || b.font_weight || b.font_italic || b.font_size ||
            b.margin != null || b.align || b.valign || b.color || b.slant || b.vertical != null ||
            b.stroke != null || b.stroke_width != null || b.stroke_color);
}

function isRtlTarget() {
  return state.settings.targetLang === "ar" || state.settings.targetLang === "he";
}

function toggleTextSettings(i) {
  _openTextIdx = _openTextIdx === i ? -1 : i;
  el.texts.querySelectorAll(".bubble-row").forEach((r, idx) => {
    r.classList.toggle("open", idx === _openTextIdx);
  });
}

function renderTexts() {
  const page = state.pages[state.active];
  if (!page || page.id !== _textsPageId) { _openTextIdx = -1; _textsPageId = page ? page.id : null; }
  const has = !!(page && page.bubbles && page.bubbles.length);
  el.texts.innerHTML = "";
  if (!has) {
    // panel is always present (like the left panel) — without texts show title and hint
    const h = document.createElement("h3");
    h.textContent = I18N.t("texts.panelTitle");
    const p = document.createElement("p");
    p.className = "tx-empty";
    p.textContent = I18N.t("texts.emptyHint");
    el.texts.append(h, p);
    fitTextsHeight();
    return;
  }
  const texts = page.bubbleTexts = ensureBubbleTexts(page);

  const h = document.createElement("h3");
  h.textContent = I18N.t("texts.heading", { count: texts.length });
  el.texts.appendChild(h);

  texts.forEach((b, i) => {
    const row = document.createElement("div");
    row.className = "bubble-row";
    row.dataset.idx = i;

    const src = document.createElement("div");
    src.className = "tx-src";
    src.innerHTML = `<span class="tx-idx">${globalBubbleIndex(page, i) + 1}.</span> ${escapeHtml(b.source_text) || I18N.t("texts.dash")}`;

    const edit = document.createElement("div");
    edit.className = "tx-edit";
    const ta = document.createElement("textarea");
    ta.className = "tx-dst";
    ta.rows = 2;
    ta.value = b.translated_text || "";
    ta.addEventListener("input", () => { b.translated_text = ta.value; autoGrow(ta); markTextsDirty(); });

    const aa = document.createElement("button");
    aa.type = "button"; aa.className = "tx-aa";
    aa.textContent = "Aa"; aa.title = I18N.t("texts.styleToggle");
    const updateAa = () => aa.classList.toggle("has-override", hasStyleOverride(b));
    aa.addEventListener("click", () => toggleTextSettings(i));
    edit.append(ta, aa);

    const styleRow = document.createElement("div");
    styleRow.className = "tx-settings tx-style";

    // --- Font family ---
    const fontSel = document.createElement("select");
    fontSel.className = "tx-font";
    fontSel.title = I18N.t("font.bubbleTitle");
    fillFontFamilySelect(fontSel, b.font || "", I18N.t("font.bubbleDefault"));
    fontSel.addEventListener("change", () => {
      b.font = fontSel.value || null;
      b.font_weight = null;   // reset on family change
      b.font_italic = null;
      fontSel.style.fontFamily = fontSel.value ? `'${fontFamilyId(fontSel.value)}'` : "";
      updateWeightSel();
      updateItalicBtn();
      updateAa(); markTextsDirty();
    });

    // --- Weight selector ---
    const weightSel = document.createElement("select");
    weightSel.className = "tx-weight";
    weightSel.title = I18N.t("font.weightTitle");
    const updateWeightSel = () => {
      const family = b.font || state.settings.defaultFont;
      const fInfo = family ? state.fonts.find(f => f.name === family) : null;
      const lang = state.settings.targetLang;
      const allWeights = (fInfo && fInfo.weights && fInfo.weights.length) ? fInfo.weights : ["Regular"];
      const weights = allWeights.filter(w => _weightSupportsLang(fInfo, w, lang));
      const show = weights.length > 1;  // only one weight = no choice → disable, but keep slot to avoid layout shift
      weightSel.disabled = !show;
      fillWeightSelect(weightSel, weights, b.font_weight || state.settings.defaultFontWeight || "Regular", show ? "↺" : null);
      weightSel.classList.toggle("inherited", show && !b.font_weight);
    };
    updateWeightSel();
    weightSel.addEventListener("change", () => {
      b.font_weight = weightSel.value || null;
      weightSel.classList.toggle("inherited", !b.font_weight);
      updateItalicBtn();
      updateAa(); markTextsDirty();
    });

    // --- Italic toggle ---
    const italicBtn = document.createElement("button");
    italicBtn.type = "button"; italicBtn.className = "btn small tx-italic";
    italicBtn.textContent = "I"; italicBtn.title = I18N.t("font.italicTitle");
    const updateItalicBtn = () => {
      const family = b.font || state.settings.defaultFont;
      const fInfo = family ? state.fonts.find(f => f.name === family) : null;
      const hasItalic = _hasItalicForLang(fInfo, state.settings.targetLang);
      italicBtn.disabled = !hasItalic;   // no italic variant → disabled, but slot stays (no layout shift)
      const isItalic = hasItalic && (b.font_italic != null ? b.font_italic : (state.settings.defaultFontItalic || false));
      italicBtn.classList.toggle("active", !!isItalic);
      italicBtn.classList.toggle("inherited", b.font_italic == null);
    };
    updateItalicBtn();
    italicBtn.addEventListener("click", () => {
      const cur = b.font_italic != null ? b.font_italic : (state.settings.defaultFontItalic || false);
      b.font_italic = !cur;
      updateItalicBtn();
      updateAa(); markTextsDirty();
    });

    // --- Font size (absolute px, free input; dbl-click resets to global) ---
    const sizeInp = document.createElement("input");
    sizeInp.type = "number"; sizeInp.min = String(FONT_SIZE_MIN); sizeInp.max = String(FONT_SIZE_MAX);
    sizeInp.className = "tx-size tx-num";
    sizeInp.title = I18N.t("size.bubbleTitle");
    const applySize = () => {
      const hasOverride = b.font_size != null;
      sizeInp.value = String(hasOverride ? b.font_size : state.settings.defaultFontSize);
      sizeInp.classList.toggle("inherited", !hasOverride);
    };
    applySize();
    sizeInp.addEventListener("input", () => {
      const v = parseInt(sizeInp.value, 10);
      b.font_size = Number.isFinite(v) ? clampFontSize(v) : null;
      sizeInp.classList.toggle("inherited", b.font_size == null);
      updateAa(); markTextsDirty();
    });
    sizeInp.addEventListener("dblclick", () => {
      b.font_size = null; applySize(); updateAa(); markTextsDirty();
    });

    // --- Margin ---
    const marginInp = document.createElement("select");
    marginInp.className = "tx-size";
    marginInp.title = I18N.t("margin.bubbleTitle");
    const applyMargin = () => {
      const eff = b.margin != null ? b.margin : state.settings.defaultMargin;
      fillMarginSelect(marginInp, eff, "↺");
      marginInp.value = String(eff);
      marginInp.classList.toggle("inherited", b.margin == null);
    };
    applyMargin();
    marginInp.addEventListener("change", () => {
      b.margin = marginInp.value === "" ? null : parseInt(marginInp.value, 10);
      applyMargin(); updateAa(); markTextsDirty();
    });

    // --- Align ---
    const alignInp = document.createElement("select");
    alignInp.className = "tx-size tx-align";
    alignInp.title = I18N.t("align.bubbleTitle");
    const applyAlign = () => {
      const eff = b.align || state.settings.defaultAlign;
      fillAlignSelect(alignInp, eff, "↺");
      alignInp.value = eff;
      alignInp.classList.toggle("inherited", !b.align);
    };
    applyAlign();
    alignInp.addEventListener("change", () => {
      b.align = alignInp.value || null;
      applyAlign(); updateAa(); markTextsDirty();
    });

    // --- Valign ---
    const valignInp = document.createElement("select");
    valignInp.className = "tx-size tx-valign";
    valignInp.title = I18N.t("valign.bubbleTitle");
    const applyValign = () => {
      const eff = b.valign || "middle";
      fillValignSelect(valignInp, eff, "↺");
      valignInp.value = eff;
      valignInp.classList.toggle("inherited", !b.valign);
    };
    applyValign();
    valignInp.addEventListener("change", () => {
      b.valign = valignInp.value || null;
      applyValign(); updateAa(); markTextsDirty();
    });

    // --- Slant ---
    const slantWrap = document.createElement("label");
    slantWrap.className = "tx-slant";
    slantWrap.title = I18N.t("slant.bubbleTitle");
    const slantInp = document.createElement("input");
    slantInp.type = "range"; slantInp.min = "-90"; slantInp.max = "90"; slantInp.step = "1";
    slantInp.value = String(b.slant || 0);
    const slantOut = document.createElement("output");
    slantOut.textContent = (b.slant || 0) + "°";
    const slantBubble = () => (state.pages[state.active] || {}).bubbles?.[i] || null;
    slantInp.addEventListener("input", () => {
      const v = parseInt(slantInp.value, 10) || 0;
      b.slant = v || null;
      slantOut.textContent = v + "°";
      showSlantGuide(slantBubble(), v);
      updateAa(); markTextsDirty();
    });
    slantInp.addEventListener("focus", () => showSlantGuide(slantBubble(), b.slant || 0));
    slantInp.addEventListener("blur", hideSlantGuide);
    slantWrap.append(slantInp, slantOut);

    // --- Vertical ---
    const vertWrap = document.createElement("label");
    vertWrap.className = "tx-vert check";
    vertWrap.title = I18N.t("vertical.bubbleTitle");
    const vertInp = document.createElement("input");
    vertInp.type = "checkbox";
    const updateVert = () => {
      const isOverride = b.vertical != null;
      vertInp.checked = isOverride ? !!b.vertical : !!(state.settings.defaultVertical);
      vertWrap.classList.toggle("inherited", !isOverride);
    };
    updateVert();
    vertInp.disabled = isRtlTarget();
    vertInp.addEventListener("change", () => {
      b.vertical = vertInp.checked ? true : false;
      vertWrap.classList.remove("inherited");
      updateAa(); markTextsDirty();
    });
    vertWrap.addEventListener("dblclick", (e) => {
      // double-click resets to the global default
      b.vertical = null;
      updateVert();
      updateAa(); markTextsDirty();
    });
    const vertLbl = document.createElement("span");
    vertLbl.textContent = I18N.t("vertical.label");
    vertWrap.append(vertLbl, vertInp);

    // --- Color ---
    const colorBtn = document.createElement("button");
    colorBtn.type = "button"; colorBtn.className = "btn color-btn tx-color";
    colorBtn.title = I18N.t("color.bubbleTitle");
    const syncColor = () => {
      colorBtn.style.background = b.color || state.settings.textColor;
      colorBtn.classList.toggle("inherited", !b.color);
    };
    syncColor();
    colorBtn.addEventListener("click", () => {
      openColorPicker(colorBtn, b.color || state.settings.textColor, (c) => {
        b.color = c; syncColor(); updateAa(); markTextsDirty();
      });
    });

    // --- Stroke (outline) toggle ---
    const strokeBtn = document.createElement("button");
    strokeBtn.type = "button"; strokeBtn.className = "btn small tx-stroke";
    strokeBtn.textContent = "S"; strokeBtn.title = I18N.t("stroke.bubbleToggleTitle");
    const updateStrokeBtn = () => {
      const isOverride = b.stroke != null;
      const on = isOverride ? !!b.stroke : !!state.settings.defaultStroke;
      strokeBtn.classList.toggle("active", on);
      strokeBtn.classList.toggle("inherited", !isOverride);
    };
    updateStrokeBtn();
    strokeBtn.addEventListener("click", () => {
      const cur = b.stroke != null ? b.stroke : !!state.settings.defaultStroke;
      b.stroke = !cur;
      updateStrokeBtn(); updateAa(); markTextsDirty();
    });
    strokeBtn.addEventListener("dblclick", () => {
      // double-click resets to the global default
      b.stroke = null;
      updateStrokeBtn(); updateAa(); markTextsDirty();
    });

    // --- Stroke width ---
    const strokeWInp = document.createElement("select");
    strokeWInp.className = "tx-size tx-stroke-w";
    strokeWInp.title = I18N.t("stroke.bubbleWidthTitle");
    const applyStrokeW = () => {
      const eff = b.stroke_width != null ? b.stroke_width : state.settings.defaultStrokeWidth;
      fillStrokeWidthSelect(strokeWInp, eff, "↺");
      strokeWInp.value = String(eff);
      strokeWInp.classList.toggle("inherited", b.stroke_width == null);
    };
    applyStrokeW();
    strokeWInp.addEventListener("change", () => {
      b.stroke_width = strokeWInp.value === "" ? null : parseInt(strokeWInp.value, 10);
      applyStrokeW(); updateAa(); markTextsDirty();
    });

    // --- Stroke color ---
    const strokeColorBtn = document.createElement("button");
    strokeColorBtn.type = "button"; strokeColorBtn.className = "btn color-btn tx-stroke-color";
    strokeColorBtn.title = I18N.t("stroke.bubbleColorTitle");
    const syncStrokeColor = () => {
      strokeColorBtn.style.background = b.stroke_color || state.settings.defaultStrokeColor;
      strokeColorBtn.classList.toggle("inherited", !b.stroke_color);
    };
    syncStrokeColor();
    strokeColorBtn.addEventListener("click", () => {
      openColorPicker(strokeColorBtn, b.stroke_color || state.settings.defaultStrokeColor, (c) => {
        b.stroke_color = c; syncStrokeColor(); updateAa(); markTextsDirty();
      });
    });

    // --- Reset all ---
    const resetAll = document.createElement("button");
    resetAll.type = "button"; resetAll.className = "btn tx-reset-all";
    resetAll.textContent = "↺"; resetAll.title = I18N.t("style.resetAll");
    const syncResetAll = () => resetAll.classList.toggle("hidden", !hasStyleOverride(b));
    syncResetAll();
    resetAll.addEventListener("click", () => {
      b.font = null; b.font_weight = null; b.font_italic = null;
      b.font_size = null; b.margin = null;
      b.align = null; b.valign = null; b.slant = null; b.vertical = null; b.color = null;
      b.stroke = null; b.stroke_width = null; b.stroke_color = null;
      fontSel.value = ""; fontSel.style.fontFamily = "";
      applySize(); applyMargin(); applyAlign(); applyValign(); syncColor();
      slantInp.value = "0"; slantOut.textContent = "0°";
      vertInp.checked = false;
      updateStrokeBtn(); applyStrokeW(); syncStrokeColor();
      updateWeightSel(); updateItalicBtn();
      updateAa(); syncResetAll(); markTextsDirty();
    });

    styleRow.append(fontSel, weightSel, italicBtn, sizeInp, marginInp, alignInp, valignInp, slantWrap, vertWrap, colorBtn, strokeBtn, strokeWInp, strokeColorBtn, resetAll);
    updateAa();
    row.classList.toggle("open", i === _openTextIdx);
    row.append(src, edit, styleRow);
    el.texts.appendChild(row);
    autoGrow(ta);
  });

  if (page.cleanDataURL) {
    const apply = document.createElement("button");
    apply.id = "texts-apply"; apply.className = "btn primary tx-apply";
    apply.textContent = I18N.t("texts.apply");
    apply.addEventListener("click", () => applyTextEdits(page));
    el.texts.appendChild(apply);
  }

  fitTextsHeight();
  if (state.selected && state.selected._bubble) {
    highlightTextRow(page.bubbles.indexOf(state.selected._bubble));
  }
}

function fitTextsHeight() {
  if (state.settings.textsCollapsed) return;
  const top = el.texts.getBoundingClientRect().top;
  el.texts.style.maxHeight = Math.max(160, window.innerHeight - top - 16) + "px";
}

function highlightTextRow(idx) {
  const rows = el.texts.querySelectorAll(".bubble-row");
  rows.forEach((r, i) => r.classList.toggle("active", i === idx));
  if (idx < 0 || idx >= rows.length) return;
  const row = rows[idx], c = el.texts;
  const rTop = row.offsetTop, rBot = rTop + row.offsetHeight;
  if (rTop < c.scrollTop) c.scrollTop = rTop - 8;
  else if (rBot > c.scrollTop + c.clientHeight) c.scrollTop = rBot - c.clientHeight + 8;
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(240, ta.scrollHeight) + "px";
}

function markTextsDirty() {
  const apply = document.getElementById("texts-apply");
  if (apply) apply.classList.add("dirty");
}

async function applyTextEdits(page) {
  if (!page || !page.bubbleTexts || !page.bubbleTexts.length) return;
  if (!page.cleanDataURL) return;
  const boxes = page.bubbleTexts.map((b, i) => {
    const bb = page.bubbles[i] || b.bbox;
    return { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2, text: b.translated_text || "", ...styleFields(b) };
  });
  const fd = new FormData();
  // Re-render text on the already-cleaned (inpainted) page — no OCR/inpaint/translation.
  // Inpaint was done during translation and stored in page.cleanDataURL; style edits don't redo it.
  fd.append("file", dataURLToBlob(page.cleanDataURL), page.name + "_clean.png");
  fd.append("boxes", JSON.stringify(boxes));
  fd.append("label", page.name);

  const apply = document.getElementById("texts-apply");
  if (apply) { apply.disabled = true; apply.textContent = I18N.t("texts.rendering"); }
  try {
    const r = await fetch("/render/boxes", { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    page.resultDataURL = data.image_b64;
    page.resultImageEl = await loadImageEl(data.image_b64);
    page.viewMode = "result";
    persistPage(page);
    if (apply) apply.classList.remove("dirty");
    if (state.pages[state.active] === page) buildStage();
  } catch (err) {
    console.error(err);
    setProgress(I18N.t("render.error", { msg: err.message }), "error");
  } finally {
    const a = document.getElementById("texts-apply");
    if (a) { a.disabled = false; a.textContent = I18N.t("texts.apply"); }
  }
}

// =====================================================================
// fonts
// =====================================================================
async function loadFonts() {
  try {
    const r = await fetch("/fonts");
    const d = await r.json();
    state.fonts = Array.isArray(d.fonts) ? d.fonts : [];
    state.fontDefaults = (d.defaults && typeof d.defaults === "object") ? d.defaults : {};
  } catch (_) { state.fonts = []; state.fontDefaults = {}; }
  // if no global font is set (stale localStorage value) — pick the per-language default
  const s = state.settings;
  if (!s.defaultFont) {
    const avail = fontsForLang(s.targetLang);
    const def = state.fontDefaults[s.targetLang] || (avail[0] && avail[0].name) || "";
    if (def) { s.defaultFont = def; saveSettings(); }
  }
  injectFontFaces();
  populateGlobalFont();
}

function fontFamilyId(name) { return "mtf-" + name.replace(/[^a-zA-Z0-9_-]/g, "_"); }

function injectFontFaces() {
  let styleEl = document.getElementById("font-previews");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "font-previews";
    document.head.appendChild(styleEl);
  }
  // One @font-face per family using Regular variant (for dropdown preview)
  styleEl.textContent = state.fonts.map(f =>
    `@font-face{font-family:'${fontFamilyId(f.name)}';` +
    `src:url('/fonts/file/${encodeURIComponent(f.name)}');font-display:swap;}`
  ).join("\n");
}

function fontsForLang(lang) {
  if (!lang) return state.fonts.slice();
  return state.fonts.filter(f => Array.isArray(f.langs) && f.langs.includes(lang));
}

// Fill a font family <select>. selected = family name; autoLabel = label for empty/"inherit" option
// (pass null to omit the empty option — used for global font where auto is no longer offered).
function fillFontFamilySelect(sel, selected, autoLabel) {
  const avail = fontsForLang(state.settings.targetLang);
  sel.innerHTML = "";
  if (autoLabel != null) sel.appendChild(new Option(autoLabel, ""));
  avail.forEach(f => {
    const opt = new Option(f.name, f.name);
    opt.style.fontFamily = `'${fontFamilyId(f.name)}'`;
    sel.appendChild(opt);
  });
  if (selected && !avail.some(f => f.name === selected)) {
    const opt = new Option(I18N.t("font.noLangSupport", { name: selected }), selected);
    opt.style.fontFamily = `'${fontFamilyId(selected)}'`;
    sel.appendChild(opt);
  }
  sel.value = selected || "";
  sel.style.fontFamily = selected ? `'${fontFamilyId(selected)}'` : "";
}

// Kept as alias for places that still call fillFontSelect
const fillFontSelect = fillFontFamilySelect;

// Fill a weight <select>. inheritLabel = label for empty/"inherit" option (or null for no inherit).
function fillWeightSelect(sel, weights, selectedWeight, inheritLabel) {
  sel.innerHTML = "";
  if (inheritLabel != null) sel.appendChild(new Option(inheritLabel, ""));
  (weights && weights.length ? weights : ["Regular"]).forEach(w => {
    sel.appendChild(new Option(w, w));
  });
  sel.value = selectedWeight || "Regular";
}

function populateGlobalFont() {
  if (!el.globalFont) return;
  const s = state.settings;
  fillFontFamilySelect(el.globalFont, s.defaultFont, null);
  el.globalFont.style.fontFamily = s.defaultFont ? `'${fontFamilyId(s.defaultFont)}'` : "";
  _syncGlobalWeightItalic();
}

function _syncGlobalWeightItalic() {
  const s = state.settings;
  const family = s.defaultFont;
  const fInfo = family ? state.fonts.find(f => f.name === family) : null;
  const lang = s.targetLang;
  const allWeights = (fInfo && fInfo.weights && fInfo.weights.length) ? fInfo.weights : ["Regular"];
  const weights = allWeights.filter(w => _weightSupportsLang(fInfo, w, lang));
  const showWeight = weights.length > 1;
  if (el.globalFontWeight) {
    // keep the control in place even with no choice (disabled) — avoids the menu jumping
    el.globalFontWeight.innerHTML = "";
    (showWeight ? weights : ["Regular"]).forEach(w => el.globalFontWeight.appendChild(new Option(w, w)));
    el.globalFontWeight.value = s.defaultFontWeight || "Regular";
    el.globalFontWeight.disabled = !showWeight || !family;
  }
  if (el.globalFontItalic) {
    const hasItalic = _hasItalicForLang(fInfo, lang);
    el.globalFontItalic.disabled = !hasItalic;
    el.globalFontItalic.classList.toggle("active", hasItalic && !!s.defaultFontItalic);
  }
}

// Absolute font size in px (free input). Size is independent of bubble dimensions.
const FONT_SIZE_MIN = 6, FONT_SIZE_MAX = 400;
function clampFontSize(v) { return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, v)); }

// Text outline width options (px)
const STROKE_WIDTH_PX = [1, 2, 3, 4, 5, 6, 8, 10];
function fillStrokeWidthSelect(sel, value, firstLabel) {
  sel.innerHTML = "";
  if (firstLabel != null) sel.appendChild(new Option(firstLabel, ""));
  STROKE_WIDTH_PX.forEach(px => sel.appendChild(new Option(`${px}px`, String(px))));
  sel.value = value == null ? "" : String(value);
}

const MARGIN_LEVELS = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40];
function fillMarginSelect(sel, value, firstLabel) {
  sel.innerHTML = "";
  if (firstLabel != null) sel.appendChild(new Option(firstLabel, ""));
  MARGIN_LEVELS.forEach(p => sel.appendChild(new Option(p + "%", String(p))));
  sel.value = value == null ? "" : String(value);
}

const ALIGN_OPTS = [["left", "align.left"], ["center", "align.center"], ["right", "align.right"]];
function fillAlignSelect(sel, value, inheritLabel) {
  sel.innerHTML = "";
  if (inheritLabel != null) sel.appendChild(new Option(inheritLabel, ""));
  ALIGN_OPTS.forEach(([v, key]) => sel.appendChild(new Option(I18N.t(key), v)));
  sel.value = value || (inheritLabel != null ? "" : "center");
}

const VALIGN_OPTS = [["top", "valign.top"], ["middle", "valign.middle"], ["bottom", "valign.bottom"]];
function fillValignSelect(sel, value, inheritLabel) {
  sel.innerHTML = "";
  if (inheritLabel != null) sel.appendChild(new Option(inheritLabel, ""));
  VALIGN_OPTS.forEach(([v, key]) => sel.appendChild(new Option(I18N.t(key), v)));
  sel.value = value || (inheritLabel != null ? "" : "middle");
}

function setupFontTools() {
  const s = state.settings;
  populateGlobalFont();

  el.globalFont.addEventListener("change", () => {
    s.defaultFont = el.globalFont.value || "";
    s.defaultFontWeight = "Regular";
    s.defaultFontItalic = false;
    el.globalFont.style.fontFamily = s.defaultFont ? `'${fontFamilyId(s.defaultFont)}'` : "";
    _syncGlobalWeightItalic();
    saveSettings();
    if (state.pages[state.active]) renderTexts();
  });

  if (el.globalFontWeight) {
    el.globalFontWeight.addEventListener("change", () => {
      s.defaultFontWeight = el.globalFontWeight.value || "Regular";
      saveSettings();
      if (state.pages[state.active]) renderTexts();
    });
  }
  if (el.globalFontItalic) {
    el.globalFontItalic.addEventListener("click", () => {
      s.defaultFontItalic = !s.defaultFontItalic;
      el.globalFontItalic.classList.toggle("active", s.defaultFontItalic);
      saveSettings();
      if (state.pages[state.active]) renderTexts();
    });
  }

  el.globalSize.min = String(FONT_SIZE_MIN); el.globalSize.max = String(FONT_SIZE_MAX);
  el.globalSize.value = String(s.defaultFontSize || 36);
  el.globalSize.addEventListener("input", () => {
    const v = parseInt(el.globalSize.value, 10);
    s.defaultFontSize = Number.isFinite(v) ? clampFontSize(v) : 36; saveSettings();
    if (state.pages[state.active]) renderTexts();
  });
  fillMarginSelect(el.globalMargin, s.defaultMargin);
  el.globalMargin.addEventListener("change", () => {
    s.defaultMargin = parseInt(el.globalMargin.value, 10) || 0; saveSettings();
    if (state.pages[state.active]) renderTexts();
  });
  fillAlignSelect(el.globalAlign, s.defaultAlign);
  el.globalAlign.addEventListener("change", () => {
    s.defaultAlign = el.globalAlign.value || "center"; saveSettings();
    if (state.pages[state.active]) renderTexts();
  });
  fillValignSelect(el.globalValign, s.defaultValign || "middle");
  el.globalValign.addEventListener("change", () => {
    s.defaultValign = el.globalValign.value || "middle"; saveSettings();
    if (state.pages[state.active]) renderTexts();
  });
  if (el.globalVertical) {
    el.globalVertical.checked = !!s.defaultVertical;
    el.globalVertical.addEventListener("change", () => {
      s.defaultVertical = el.globalVertical.checked; saveSettings();
      if (state.pages[state.active]) renderTexts();
    });
  }
  el.globalColor.style.background = s.textColor;
  el.globalColor.addEventListener("click", () => {
    openColorPicker(el.globalColor, s.textColor, (c) => {
      s.textColor = c; el.globalColor.style.background = c; saveSettings();
      if (state.pages[state.active]) renderTexts();
    });
  });

  // --- Stroke (outline) ---
  if (el.globalStroke) {
    el.globalStroke.checked = !!s.defaultStroke;
    el.globalStroke.addEventListener("change", () => {
      s.defaultStroke = el.globalStroke.checked; saveSettings();
      if (state.pages[state.active]) renderTexts();
    });
  }
  if (el.globalStrokeWidth) {
    fillStrokeWidthSelect(el.globalStrokeWidth, s.defaultStrokeWidth);
    el.globalStrokeWidth.addEventListener("change", () => {
      s.defaultStrokeWidth = parseInt(el.globalStrokeWidth.value, 10) || 2; saveSettings();
      if (state.pages[state.active]) renderTexts();
    });
  }
  if (el.globalStrokeColor) {
    el.globalStrokeColor.style.background = s.defaultStrokeColor;
    el.globalStrokeColor.addEventListener("click", () => {
      openColorPicker(el.globalStrokeColor, s.defaultStrokeColor, (c) => {
        s.defaultStrokeColor = c; el.globalStrokeColor.style.background = c; saveSettings();
        if (state.pages[state.active]) renderTexts();
      });
    });
  }
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
