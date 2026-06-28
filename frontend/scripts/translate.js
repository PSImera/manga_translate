"use strict";
// [module] drawing new frames + translation (page/all/bubble)
// draw a new frame in «add» mode
function setupStageDrawing() {
  let drawing = null;
  stage.on("mousedown touchstart", (e) => {
    if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return; // left button only (middle = pan)
    if (brush.active) { brushStart(); return; }
    if (!state.addMode) {
      if (e.target === stage || e.target.getLayer() === imageLayer) deselect();
      return;
    }
    if (e.target !== stage && e.target.getLayer() !== imageLayer) return;
    const p = stage.getPointerPosition();
    drawing = new Konva.Rect({
      x: p.x, y: p.y, width: 0, height: 0,
      stroke: state.settings.frameColor, strokeWidth: 2, name: "bubble", draggable: true,
    });
    drawing._start = { x: p.x, y: p.y };
    bubbleLayer.add(drawing);
  });
  stage.on("mousemove touchmove", () => {
    if (brush.active) { brushMove(); return; }
    if (!drawing) return;
    const p = stage.getPointerPosition();
    drawing.x(Math.min(p.x, drawing._start.x));
    drawing.y(Math.min(p.y, drawing._start.y));
    drawing.width(Math.abs(p.x - drawing._start.x));
    drawing.height(Math.abs(p.y - drawing._start.y));
    bubbleLayer.draw();
  });
  stage.on("mouseup touchend", () => {
    if (brush.active) { brushEnd(); return; }
    if (!drawing) return;
    const page = state.pages[state.active];
    const x1 = c2o(drawing.x()), y1 = c2o(drawing.y());
    const x2 = c2o(drawing.x() + drawing.width()), y2 = c2o(drawing.y() + drawing.height());
    drawing.destroy();
    drawing = null;
    if (x2 - x1 >= MIN_BOX && y2 - y1 >= MIN_BOX) {
      const b = { x1, y1, x2, y2, conf: 1.0 };
      const at = insertReadingOrder(page, b);   // inserted at its reading-order position
      // keep texts aligned: insert an empty placeholder at the same index
      if (page.bubbleTexts && page.bubbleTexts.length)
        page.bubbleTexts.splice(at, 0, { bbox: { x1, y1, x2, y2 }, source_text: "", translated_text: "", font: null, font_size: null, color: null });
      page.status = "ready"; page.statusText = I18N.t("badge.frames", { count: page.bubbles.length });
      const rect = addRect(b);
      selectRect(rect);
      renderThumbs();
      renderExpand();
      refreshBubbleIndices();
      renderTexts();
      syncOrderTools();
      scheduleMaskPreview(page);
    }
    bubbleLayer.draw();
  });
}

function toggleAddMode() {
  state.addMode = !state.addMode;
  el.addModeBtn.classList.toggle("active", state.addMode);
  if (state.addMode) { if (state.numberMode) exitNumberMode(); deselect(); deactivateBrush(); }
}

// =====================================================================
// translation
// =====================================================================
async function translateOne(page, context) {
  if (!page) return;
  const { ocr_lang, target_lang } = transLangs();
  const texts = ensureBubbleTexts(page);
  const fd = new FormData();
  fd.append("file", dataURLToBlob(page.dataURL), page.name + ".png");
  fd.append("boxes", JSON.stringify(page.bubbles.map((b, i) => ({
    x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
    ocr_lang: bubbleParam(b, "ocrLang"),
    ...maskFields(b),
    ...styleFields(texts[i]),
  }))));
  fd.append("ocr_lang", ocr_lang);
  fd.append("target_lang", target_lang);
  fd.append("lama_model", state.settings.lamaModel);
  fd.append("mask_expand", state.settings.maskExpand / 100);
  // previous pages context (only in «Translate all») — model sees the manga plot so far
  if (context && context.length) fd.append("context", JSON.stringify(context));
  fd.append("label", page.name);
  // manual mask edits (brush/eraser) — exactly what is visible in the preview will be erased
  if (page.hasPaint && page.paintCanvas) fd.append("mask_add", page.paintCanvas.toDataURL("image/png"));
  if (page.hasErase && page.eraseCanvas) fd.append("mask_erase", page.eraseCanvas.toDataURL("image/png"));

  page.status = "translating"; page.statusText = I18N.t("status.translating"); renderThumbs();
  const ctrl = registerAbort();
  let ok = false;
  try {
    const r = await fetch("/translate/boxes", { method: "POST", body: fd, signal: ctrl.signal });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    page.resultDataURL = data.image_b64;
    page.resultImageEl = await loadImageEl(data.image_b64);
    page.cleanDataURL = data.clean_b64 || null;   // inpainted page — for re-rendering text edits
    page.maskDataURL = data.mask_b64 || null;
    page.maskImageEl = data.mask_b64 ? await loadImageEl(data.mask_b64) : null;
    // carry per-bubble style (font/size/margin/align/slant/color) set BEFORE translation —
    // the response doesn't include it
    const prevTexts = page.bubbleTexts || [];
    page.bubbleTexts = (data.bubbles || []).map((nb, i) => ({ ...nb, ...carryStyle(prevTexts[i]) }));
    page.status = "done"; page.statusText = I18N.t("status.translated");
    page.viewMode = "result";
    ok = true;
  } catch (err) {
    if (err.name === "AbortError") {
      page.status = "ready"; page.statusText = I18N.t("badge.frames", { count: page.bubbles.length });
    } else {
      page.status = "error"; page.statusText = I18N.t("status.translateError");
      console.error(err);
      setProgress(I18N.t("translate.error", { name: page.name, msg: err.message }), "error");
    }
  } finally {
    unregisterAbort(ctrl);
  }
  persistPage(page);
  renderThumbs();
  if (state.pages[state.active] === page) buildStage();
  return ok;
}

function _deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// wait for page detection to finish (in case «Translate» was pressed before detection completed)
async function waitDetection(page) {
  while (page && page.status === "detecting" && !state.cancel) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// «Translate all» pipeline: TWO independent passes.
//  - GPU clean (cleanPage) runs AHEAD in the queue, one page at a time — our GPU isn't idle
//    while the external LLM thinks about previous pages (visible in thumbnails:
//    later pages are already «inpainting» while earlier ones are still «translating»).
//  - LLM+render (translateRenderPage) runs in order accumulating context, only waiting for
//    its OWN page's clean pass. Text rendering waits for both.
// If the LLM is faster than inpaint (external API) the translation loop waits instead.
// Pages are coupled by a single signal: per-page clean readiness via _cleanDefer.
async function translateAll() {
  if (state._batchRunning) return;   // don't start a second pipeline on top of a running one
  state._batchRunning = true;
  state.cancel = false;
  const pages = state.pages.slice();
  const total = pages.length;
  pages.forEach((p) => { p._cleanDefer = _deferred(); });

  const cleanLoop = (async () => {
    for (let i = 0; i < total; i++) {
      await waitDetection(pages[i]);   // in case «Translate» was pressed before detection finished
      if (state.cancel) { pages[i]._cleanDefer.resolve(false); continue; }
      const ok = await cleanPage(pages[i]);
      pages[i]._cleanDefer.resolve(ok);
    }
  })();

  const transLoop = (async () => {
    const context = [];
    for (let i = 0; i < total; i++) {
      const ok = await pages[i]._cleanDefer.promise;
      if (state.cancel) break;
      if (!ok) continue;   // no frames or clean error — nothing to translate
      setClientStatus(I18N.t("translate.progress", { i: i + 1, total }));
      const s = state.settings;
      const ctxSlice = !s.useContext ? null
        : s.contextWindow > 0 ? context.slice(-s.contextWindow) : context;
      const done = await translateRenderPage(pages[i], ctxSlice);
      if (state.cancel) break;
      if (done && s.useContext) context.push(pageContextPairs(pages[i]));
    }
  })();

  try {
    await Promise.all([cleanLoop, transLoop]);
  } finally {
    state._batchRunning = false;
  }
  setClientStatus("");
  if (state.cancel) { state.cancel = false; }
  else { setProgress(I18N.t("common.done")); setDoneStatus("translation"); }
}

// GPU phase: OCR + inpaint for a page (no LLM/render). Stores the clean page and
// OCR source texts in page; translateRenderPage will pick them up.
async function cleanPage(page) {
  if (!page) return false;
  const { ocr_lang } = transLangs();
  const fd = new FormData();
  fd.append("file", dataURLToBlob(page.dataURL), page.name + ".png");
  fd.append("boxes", JSON.stringify(page.bubbles.map((b) => ({
    x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
    ocr_lang: bubbleParam(b, "ocrLang"),
    ...maskFields(b),
  }))));
  fd.append("ocr_lang", ocr_lang);
  fd.append("lama_model", state.settings.lamaModel);
  fd.append("mask_expand", state.settings.maskExpand / 100);
  fd.append("label", page.name);
  if (page.hasPaint && page.paintCanvas) fd.append("mask_add", page.paintCanvas.toDataURL("image/png"));
  if (page.hasErase && page.eraseCanvas) fd.append("mask_erase", page.eraseCanvas.toDataURL("image/png"));

  page.status = "cleaning"; page.statusText = I18N.t("status.cleaning"); renderThumbs();
  const ctrl = registerAbort();
  let ok = false;
  try {
    const r = await fetch("/clean/boxes", { method: "POST", body: fd, signal: ctrl.signal });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    page.cleanDataURL = data.clean_b64 || null;
    page.maskDataURL = data.mask_b64 || null;
    page.maskImageEl = data.mask_b64 ? await loadImageEl(data.mask_b64) : null;
    // store OCR source text in bubbleTexts; carry any individual style that was already set
    const prev = page.bubbleTexts || [];
    page.bubbleTexts = (data.bubbles || []).map((nb, i) => ({
      bbox: nb.bbox, source_text: nb.source_text,
      translated_text: (prev[i] && prev[i].translated_text) || "",
      ...carryStyle(prev[i]),
    }));
    page.status = "cleaned"; page.statusText = I18N.t("status.cleaned");
    ok = true;
  } catch (err) {
    if (err.name === "AbortError") {
      page.status = "ready"; page.statusText = I18N.t("badge.frames", { count: page.bubbles.length });
    } else {
      page.status = "error"; page.statusText = I18N.t("status.translateError");
      console.error(err);
      setProgress(I18N.t("translate.error", { name: page.name, msg: err.message }), "error");
    }
  } finally {
    unregisterAbort(ctrl);
  }
  persistPage(page);
  renderThumbs();
  if (state.pages[state.active] === page) buildStage();
  return ok;
}

// LLM+render phase on the already-cleaned page (page.cleanDataURL).
async function translateRenderPage(page, context) {
  if (!page || !page.cleanDataURL) return false;
  const { ocr_lang, target_lang } = transLangs();
  const texts = ensureBubbleTexts(page);
  const fd = new FormData();
  fd.append("file", dataURLToBlob(page.cleanDataURL), page.name + "_clean.png");
  fd.append("boxes", JSON.stringify(page.bubbles.map((b, i) => ({
    x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
    text: (texts[i] && texts[i].source_text) || "",
    ...styleFields(texts[i]),
  }))));
  fd.append("ocr_lang", ocr_lang);
  fd.append("target_lang", target_lang);
  if (context && context.length) fd.append("context", JSON.stringify(context));
  fd.append("label", page.name);

  page.status = "translating"; page.statusText = I18N.t("status.translating"); renderThumbs();
  const ctrl = registerAbort();
  let ok = false;
  try {
    const r = await fetch("/translate/render", { method: "POST", body: fd, signal: ctrl.signal });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    page.resultDataURL = data.image_b64;
    page.resultImageEl = await loadImageEl(data.image_b64);
    const prev = page.bubbleTexts || [];
    page.bubbleTexts = (data.bubbles || []).map((nb, i) => ({ ...nb, ...carryStyle(prev[i]) }));
    page.status = "done"; page.statusText = I18N.t("status.translated");
    page.viewMode = "result";
    ok = true;
  } catch (err) {
    if (err.name === "AbortError") {
      page.status = "cleaned"; page.statusText = I18N.t("status.cleaned");
    } else {
      page.status = "error"; page.statusText = I18N.t("status.translateError");
      console.error(err);
      setProgress(I18N.t("translate.error", { name: page.name, msg: err.message }), "error");
    }
  } finally {
    unregisterAbort(ctrl);
  }
  persistPage(page);
  renderThumbs();
  if (state.pages[state.active] === page) buildStage();
  return ok;
}

// {source, translated} pairs from a translated page, used as context for subsequent pages.
function pageContextPairs(page) {
  return (page.bubbleTexts || [])
    .map((t) => ({ source: t.source_text || "", translated: t.translated_text || "" }))
    .filter((p) => p.source.trim() && p.translated.trim());
}

// Already-translated pages before activeIdx as context for single-page re-translation.
// contextPages=0 → no context; >0 → last N pages.
function prevPagesContext(activeIdx) {
  const n = state.settings.contextPages;
  if (n === 0) return [];
  const out = [];
  for (let p = 0; p < activeIdx; p++) {
    const pairs = pageContextPairs(state.pages[p]);
    if (pairs.length) out.push(pairs);
  }
  return n > 0 ? out.slice(-n) : out;
}

// N preceding dialogue lines (across page boundaries) before bubbleIdx on the active page.
// n=0 → no context; >0 → last N.
function precedingBubbleContext(activeIdx, bubbleIdx, n) {
  if (n === 0) return null;
  const pairs = [];
  for (let p = 0; p <= activeIdx; p++) {
    const texts = state.pages[p].bubbleTexts || [];
    const limit = p === activeIdx ? bubbleIdx : texts.length;
    for (let i = 0; i < limit; i++) {
      const t = texts[i];
      if (t && (t.source_text || "").trim() && (t.translated_text || "").trim())
        pairs.push({ source: t.source_text, translated: t.translated_text });
    }
  }
  const slice = n > 0 ? pairs.slice(-n) : pairs;
  return slice.length ? [slice] : null;
}

// composite patch region onto base (both in original w×h coordinates) → dataURL
function compositeRegion(baseImg, patchImg, x1, y1, x2, y2, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.drawImage(baseImg, 0, 0, w, h);
  const rw = x2 - x1, rh = y2 - y1;
  if (rw > 0 && rh > 0) ctx.drawImage(patchImg, x1, y1, rw, rh, x1, y1, rw, rh);
  return cv.toDataURL("image/png");
}

// text array aligned with page.bubbles by index (missing entries are empty placeholders)
function ensureBubbleTexts(page) {
  const cur = page.bubbleTexts || [];
  return page.bubbles.map((bb, i) => cur[i] || {
    bbox: { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 },
    source_text: "", translated_text: "", font: null, font_size: null, color: null,
  });
}

// Translate ONLY the selected bubble: send one box via /translate/boxes (against the original),
// then composite its region into the current result and clean page — other bubbles untouched.
// If the page has not been translated yet, the original image serves as the base.
async function translateSelected() {
  const page = state.pages[state.active];
  const b = selectedBubble();
  if (!page || !b) return;
  const idx = page.bubbles.indexOf(b);
  if (idx < 0) return;
  const { ocr_lang, target_lang } = transLangs();

  const fd = new FormData();
  fd.append("file", dataURLToBlob(page.dataURL), page.name + ".png");
  fd.append("boxes", JSON.stringify([{
    x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
    ocr_lang: bubbleParam(b, "ocrLang"),
    ...maskFields(b),
    ...styleFields(ensureBubbleTexts(page)[idx]),
  }]));
  fd.append("ocr_lang", ocr_lang);
  fd.append("target_lang", target_lang);
  fd.append("lama_model", state.settings.lamaModel);
  fd.append("mask_expand", state.settings.maskExpand / 100);
  fd.append("label", page.name);
  // single-bubble edit: special prompt + cache bypass + preceding dialogue context
  fd.append("edit_mode", "true");
  const ctx = state.settings.useContext
    ? precedingBubbleContext(state.active, idx, state.settings.contextBubbles)
    : null;
  if (ctx) fd.append("context", JSON.stringify(ctx));
  if (page.hasPaint && page.paintCanvas) fd.append("mask_add", page.paintCanvas.toDataURL("image/png"));
  if (page.hasErase && page.eraseCanvas) fd.append("mask_erase", page.eraseCanvas.toDataURL("image/png"));

  state.cancel = false;
  const prevStatus = page.status, prevText = page.statusText;
  page.status = "translating"; page.statusText = I18N.t("status.translatingBubble"); renderThumbs();
  const ctrl = registerAbort();
  try {
    const r = await fetch("/translate/boxes", { method: "POST", body: fd, signal: ctrl.signal });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const patchRes = await loadImageEl(data.image_b64);
    const patchClean = data.clean_b64 ? await loadImageEl(data.clean_b64) : null;
    const W = page.width, H = page.height;

    // composite region = bbox + small pad (mask may spill slightly outside), clipped to image bounds
    const pad = (bubbleParam(b, "grow") || 0) + 4;
    const rx1 = Math.max(0, b.x1 - pad), ry1 = Math.max(0, b.y1 - pad);
    const rx2 = Math.min(W, b.x2 + pad), ry2 = Math.min(H, b.y2 + pad);

    const baseRes = page.resultImageEl || page.imageEl;
    const baseClean = page.cleanDataURL ? await loadImageEl(page.cleanDataURL) : page.imageEl;

    page.resultDataURL = compositeRegion(baseRes, patchRes, rx1, ry1, rx2, ry2, W, H);
    page.resultImageEl = await loadImageEl(page.resultDataURL);
    if (patchClean) {
      page.cleanDataURL = compositeRegion(baseClean, patchClean, rx1, ry1, rx2, ry2, W, H);
    }

    // texts: update only the selected bubble, carry individual style from the previous edit
    const texts = ensureBubbleTexts(page);
    const nb = data.bubbles && data.bubbles[0];
    if (nb) {
      texts[idx] = {
        bbox: nb.bbox,
        source_text: nb.source_text,
        translated_text: nb.translated_text,
        ...carryStyle(texts[idx]),
      };
    }
    page.bubbleTexts = texts;

    page.status = "done"; page.statusText = I18N.t("status.translated");
    page.viewMode = "result";
    setDoneStatus("translation");
  } catch (err) {
    page.status = prevStatus; page.statusText = prevText;
    if (err.name !== "AbortError") {
      console.error(err);
      setProgress(I18N.t("translate.bubbleError", { name: page.name, msg: err.message }), "error");
    }
  } finally {
    unregisterAbort(ctrl);
  }
  persistPage(page);
  renderThumbs();
  if (state.pages[state.active] === page) { buildStage(); renderTexts(); }
}

