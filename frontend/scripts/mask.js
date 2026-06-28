"use strict";
// [module] inpaint mask: expand border, overlay, brush/eraser, preview
// expanded inpaint context border (approx. from bbox) — one per frame
function renderExpand() {
  if (!expandLayer) return;
  expandLayer.destroyChildren();
  const page = state.pages[state.active];
  if (page && page.viewMode !== "result" && state.settings.showFrames) {
    page.bubbles.forEach((b) => {
      if (!bubbleParam(b, "showExpand")) return;
      // inpaint context size — its own parameter, independent of mask detection settings
      const f = bubbleParam(b, "inpaintPad") / 100; // fraction of bubble size
      const rx = (f / 2) * (b.x2 - b.x1);
      const ry = (f / 2) * (b.y2 - b.y1);
      const x1 = Math.max(0, b.x1 - rx), y1 = Math.max(0, b.y1 - ry);
      const x2 = Math.min(page.width, b.x2 + rx), y2 = Math.min(page.height, b.y2 + ry);
      expandLayer.add(new Konva.Rect({
        x: o2c(x1), y: o2c(y1), width: o2c(x2 - x1), height: o2c(y2 - y1),
        stroke: bubbleParam(b, "color"), strokeWidth: 1, dash: [6, 4], opacity: 0.7,
      }));
    });
  }
  expandLayer.draw();
}

// Slant preview (while dragging the slant slider): pivot = bubble center (text rotates around it
// on render), and a dashed «horizon line» at the slant angle so you can see how the text will sit.
// Positive angle raises the right end (matches renderer behavior).
function showSlantGuide(bubble, angleDeg) {
  if (!guideLayer || !bubble) return;
  guideLayer.destroyChildren();
  const cx = (bubble.x1 + bubble.x2) / 2, cy = (bubble.y1 + bubble.y2) / 2;
  const rad = (angleDeg || 0) * Math.PI / 180;
  const L = Math.max(bubble.x2 - bubble.x1, bubble.y2 - bubble.y1) * 0.6;
  const dx = Math.cos(rad) * L, dy = Math.sin(rad) * L;
  guideLayer.add(new Konva.Line({
    points: [o2c(cx - dx), o2c(cy + dy), o2c(cx + dx), o2c(cy - dy)],
    stroke: "#4c8dff", strokeWidth: 1.5, dash: [6, 4], opacity: 0.9,
  }));
  guideLayer.add(new Konva.Circle({
    x: o2c(cx), y: o2c(cy), radius: 4, fill: "#4c8dff", stroke: "#fff", strokeWidth: 1,
  }));
  guideLayer.draw();
}

function hideSlantGuide() {
  if (!guideLayer) return;
  guideLayer.destroyChildren();
  guideLayer.draw();
}

// Mask overlay = ((auto-detection ∪ brush) \ eraser), recolored to the mask color.
// We keep one tint canvas per page AT STAGE RESOLUTION (page._maskTintCanvas) and one
// reusable Konva node (_maskNode): the brush draws into that canvas incrementally (just the
// stamp), with no downscaling of full-res (up to 4K) canvases and no new nodes each frame.
let _maskNode = null;

// Full rebuild of the tint canvas from all sources (auto mask + brush − eraser), then recolor
// to the mask color preserving alpha. Expensive (4K downscale), so only on
// detection/frame edits/color change — NOT on every stroke.
function drawComposedTint(page, ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  if (page.maskImageEl) ctx.drawImage(page.maskImageEl, 0, 0, w, h);
  if (page.hasPaint && page.paintCanvas) ctx.drawImage(page.paintCanvas, 0, 0, w, h);
  if (page.hasErase && page.eraseCanvas) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(page.eraseCanvas, 0, 0, w, h);
  }
  ctx.globalCompositeOperation = "source-in"; // recolor, keeping alpha
  ctx.fillStyle = state.settings.maskColor;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
}

// is there anything to show (the eraser alone draws nothing)
function maskHasContent(page) {
  return !!(page && (page.maskImageEl || (page.hasPaint && page.paintCanvas)));
}

// page tint canvas at stage size; seeded from current sources on creation
function ensureTintCanvas(page) {
  const w = stage.width(), h = stage.height();
  let c = page._maskTintCanvas;
  if (!c || c.width !== w || c.height !== h) {
    c = document.createElement("canvas");
    c.width = w; c.height = h;
    page._maskTintCanvas = c;
    drawComposedTint(page, c.getContext("2d"), w, h);
  }
  return c;
}

function ensureMaskNode() {
  if (_maskNode && _maskNode.getLayer() === maskLayer) return _maskNode;
  _maskNode = new Konva.Image({
    image: null, width: stage.width(), height: stage.height(), listening: false,
  });
  maskLayer.add(_maskNode);
  return _maskNode;
}

function renderMask() {
  if (!maskLayer) return;
  const page = state.pages[state.active];
  // overlay is visible when the «🖌 Маска» set is expanded (it doubles as the show toggle), but
  // «Рамки» is the parent menu: collapse it and the mask hides too (inherits visibility)
  const show = !!(page && state.settings.showMask && state.settings.showFrames);
  const node = ensureMaskNode();
  if (!show || !maskHasContent(page)) {
    node.visible(false);
    maskLayer.batchDraw();
    return;
  }
  const c = ensureTintCanvas(page);
  drawComposedTint(page, c.getContext("2d"), c.width, c.height); // full rebuild
  node.image(c);
  node.width(stage.width()); node.height(stage.height());
  node.opacity(state.settings.maskOpacity / 100); // single opacity (auto + brush)
  node.visible(true);
  maskLayer.batchDraw();
}

// redraw the mask overlay at most once per frame (for a smooth brush)
let _maskRaf = 0;
function scheduleMaskRender() {
  if (_maskRaf) return;
  _maskRaf = requestAnimationFrame(() => { _maskRaf = 0; renderMask(); });
}

// redraw only the Konva node (the canvas was already updated incrementally by the brush), once per frame
let _maskNodeRaf = 0;
function scheduleMaskNodeDraw() {
  if (_maskNodeRaf) return;
  _maskNodeRaf = requestAnimationFrame(() => { _maskNodeRaf = 0; if (maskLayer) maskLayer.batchDraw(); });
}

// opacity change — node property only (we don't touch the color tint); a full renderMask
// only if the node doesn't exist yet
function applyMaskOpacity() {
  if (_maskNode && _maskNode.getLayer() === maskLayer) {
    _maskNode.opacity(state.settings.maskOpacity / 100);
    scheduleMaskNodeDraw();
  } else {
    renderMask();
  }
}

// Incremental brush stamp into the tint canvas (in stage coordinates) — no rebuild from sources.
// The brush draws straight in the mask color; the eraser cuts out (destination-out). Mirrors
// strokeStamp, which writes the orig-res edits for the backend in parallel.
function paintPreview(page, x0, y0, x1, y1) {
  const c = ensureTintCanvas(page);
  const ctx = c.getContext("2d");
  const erase = brush.mode === "erase";
  const r = (brush.size / 2) * scale;
  ctx.save();
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.fillStyle = state.settings.maskColor;
  ctx.strokeStyle = state.settings.maskColor;
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = brush.size * scale;
  const cx0 = o2c(x0), cy0 = o2c(y0);
  ctx.beginPath(); ctx.arc(cx0, cy0, r, 0, Math.PI * 2); ctx.fill();
  if (x1 !== undefined) {
    const cx1 = o2c(x1), cy1 = o2c(y1);
    ctx.beginPath(); ctx.moveTo(cx0, cy0); ctx.lineTo(cx1, cy1); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx1, cy1, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  const node = ensureMaskNode();
  node.image(c);
  node.width(stage.width()); node.height(stage.height());
  node.opacity(state.settings.maskOpacity / 100);
  node.visible(true);
  scheduleMaskNodeDraw();
}

// =====================================================================
// brush/eraser for the inpaint mask
// =====================================================================
function ensureEditCanvas(page, mode) {
  const key = mode === "erase" ? "eraseCanvas" : "paintCanvas";
  if (!page[key]) {
    const c = document.createElement("canvas");
    c.width = page.width; c.height = page.height;
    page[key] = c;
  }
  return page[key];
}

// Stroke (point/segment) into the orig-res canvas for the current mode; in the opposite canvas
// erase the same area (destination-out) — brush and eraser are mutually exclusive,
// «last action wins», including over auto-detected pixels.
function strokeStamp(page, x0, y0, x1, y1) {
  const r = brush.size / 2;
  const draw = (ctx, erase) => {
    ctx.save();
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.fillStyle = "rgba(255,0,0,1)";
    ctx.strokeStyle = "rgba(255,0,0,1)";
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = brush.size;
    ctx.beginPath(); ctx.arc(x0, y0, r, 0, Math.PI * 2); ctx.fill();
    if (x1 !== undefined) {
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.beginPath(); ctx.arc(x1, y1, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };
  const self = ensureEditCanvas(page, brush.mode);
  draw(self.getContext("2d"), false);
  const other = brush.mode === "erase" ? page.paintCanvas : page.eraseCanvas;
  if (other) draw(other.getContext("2d"), true);
  if (brush.mode === "erase") page.hasErase = true; else page.hasPaint = true;
}

function brushPos() {
  const p = stage.getPointerPosition();
  return p ? { x: c2o(p.x), y: c2o(p.y) } : null;
}

function brushStart() {
  const page = state.pages[state.active];
  if (!page || page.viewMode !== "original") return;
  const pos = brushPos(); if (!pos) return;
  brush.painting = true;
  strokeStamp(page, pos.x, pos.y);              // orig-res edits for the backend
  paintPreview(page, pos.x, pos.y);             // incremental preview, no 4K downscale
  brush.last = pos;
}

function brushMove() {
  if (!brush.painting) return;
  const page = state.pages[state.active];
  const pos = brushPos(); if (!page || !pos) return;
  strokeStamp(page, brush.last.x, brush.last.y, pos.x, pos.y);
  paintPreview(page, brush.last.x, brush.last.y, pos.x, pos.y);
  brush.last = pos;
}

function brushEnd() {
  if (!brush.painting) return;
  brush.painting = false; brush.last = null;
  renderMask();
  persistPage(state.pages[state.active]);
}

// frame interactivity: disable selection/drag while brush mode is active
function applyBrushInteractivity() {
  if (bubbleLayer) bubbleLayer.listening(!brush.active);
  el.stageContainer.classList.toggle("brushing", brush.active);
  if (!brush.active) el.brushCursor.classList.add("hidden");
}

// Activate brush/eraser by selecting the tool; clicking the active tool again deactivates it.
// The «🖌 Mask» button highlight (brush-on) indicates drawing mode even when the submenu is closed.
function setBrushTool(mode) {
  if (brush.active && brush.mode === mode) {
    deactivateBrush();
    return;
  }
  brush.active = true; brush.mode = mode;
  if (state.numberMode) exitNumberMode();
  if (state.addMode) toggleAddMode();
  deselect();
  el.brushPaint.classList.toggle("active", mode === "paint");
  el.brushErase.classList.toggle("active", mode === "erase");
  el.maskToggle.classList.add("brush-on");
  applyBrushInteractivity();
}

function deactivateBrush() {
  if (!brush.active) return;
  brush.active = false;
  el.brushPaint.classList.remove("active");
  el.brushErase.classList.remove("active");
  el.maskToggle.classList.remove("brush-on");
  applyBrushInteractivity();
}

function clearEdits() {
  const page = state.pages[state.active];
  if (!page) return;
  page.paintCanvas = null; page.eraseCanvas = null;
  page.hasPaint = false; page.hasErase = false;
  renderMask();
  persistPage(page);
}

// true if the brush/eraser canvases have non-transparent pixels within the frame's bbox —
// meaning there are edits to clear (otherwise the button is dimmed).
function bubbleHasBrushEdits(page, b) {
  if (!page || !b) return false;
  const x = Math.max(0, Math.round(b.x1)), y = Math.max(0, Math.round(b.y1));
  const w = Math.round(b.x2 - b.x1), h = Math.round(b.y2 - b.y1);
  if (w <= 0 || h <= 0) return false;
  for (const c of [page.paintCanvas, page.eraseCanvas]) {
    if (!c) continue;
    const cw = Math.min(w, c.width - x), ch = Math.min(h, c.height - y);
    if (cw <= 0 || ch <= 0) continue;
    const data = c.getContext("2d").getImageData(x, y, cw, ch).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
  }
  return false;
}

// Clear manual mask edits (brush and eraser) only within the selected frame's bbox —
// unlike «Clear all», which resets all page edits. Edits live in orig-res canvases,
// so we clear the bbox rectangle in both.
function clearBubbleEdits(b) {
  const page = state.pages[state.active];
  if (!page || !b) return;
  const x = Math.round(b.x1), y = Math.round(b.y1);
  const w = Math.round(b.x2 - b.x1), h = Math.round(b.y2 - b.y1);
  let changed = false;
  for (const c of [page.paintCanvas, page.eraseCanvas]) {
    if (c) { c.getContext("2d").clearRect(x, y, w, h); changed = true; }
  }
  if (!changed) return;
  renderMask();
  persistPage(page);
  syncBubblePanel();          // refresh button state (there may be no edits left)
}

function initBrush() {
  // «🖌 Mask» button — toggle: expands/collapses the inline mask control set and
  // simultaneously acts as the mask overlay visibility switch (expanded = mask visible).
  el.maskToggle.addEventListener("click", () => {
    const open = el.maskTools.classList.toggle("hidden") === false;
    el.maskToggle.classList.toggle("active", open);
    state.settings.showMask = open; saveSettings();
    if (!open) deactivateBrush();                 // collapsed — exit drawing mode
    const page = state.pages[state.active];
    // mask is always computed in background; if not yet available for this page — compute it now
    if (open && page && !page.maskImageEl && page.bubbles.length) scheduleMaskPreview(page, 50);
    renderMask();
  });
  el.brushPaint.addEventListener("click", () => setBrushTool("paint"));
  el.brushErase.addEventListener("click", () => setBrushTool("erase"));
  el.brushClear.addEventListener("click", clearEdits);
  el.brushSize.value = brush.size; el.brushSizeOut.textContent = `${brush.size}`;
  el.brushSize.addEventListener("input", () => {
    brush.size = +el.brushSize.value; el.brushSizeOut.textContent = `${brush.size}`;
  });
  // circle cursor showing the brush diameter over the page
  el.stageContainer.addEventListener("pointermove", (e) => {
    const page = state.pages[state.active];
    if (!brush.active || !page || page.viewMode !== "original") {
      el.brushCursor.classList.add("hidden"); return;
    }
    const wrap = el.stageWrap.getBoundingClientRect();
    const d = brush.size * scale;
    el.brushCursor.style.width = el.brushCursor.style.height = `${d}px`;
    el.brushCursor.style.left = `${e.clientX - wrap.left}px`;
    el.brushCursor.style.top = `${e.clientY - wrap.top}px`;
    el.brushCursor.classList.remove("hidden");
  });
  el.stageContainer.addEventListener("pointerleave", () => el.brushCursor.classList.add("hidden"));
  // releasing the pointer outside the stage also ends the stroke
  window.addEventListener("pointerup", brushEnd);
}

// =====================================================================
// inpaint mask preview (computed BEFORE translation, from current frames)
// =====================================================================
// After detection/frame edits we wait for a pause (user stopped touching the frame) and
// recompute the mask — so the user can see what will be erased before hitting «Translate».
// Debounce timer and «mask computing» flag are PER-PAGE. A shared timer broke batch mode:
// with several pages detecting simultaneously each reset the single timer, and only the
// last page's mask was actually computed. Per-page timer → each page gets its own preview.
function setMaskPending(page, val) {
  if (!page || !!page._maskPending === !!val) return;
  page._maskPending = !!val;
  renderThumbs();                       // reflect the «mask…» indicator on the thumbnail
  refreshBusyStatus();                  // fills the status bar gap between detection and OCR
}

function scheduleMaskPreview(page, delay = 900) {
  if (!page) return;
  persistPage(page); // frame/param edits go through here — persist progress as a side effect
  setMaskPending(page, true);
  clearTimeout(page._maskTimer);
  page._maskTimer = setTimeout(() => requestMaskPreview(page), delay);
}

async function requestMaskPreview(page) {
  if (!page) return;
  if (!page.bubbles.length) {
    page.maskDataURL = null; page.maskImageEl = null;
    setMaskPending(page, false);
    if (state.pages[state.active] === page) renderMask();
    return;
  }
  const { ocr_lang } = transLangs();
  const fd = new FormData();
  fd.append("file", dataURLToBlob(page.dataURL), page.name + ".png");
  fd.append("boxes", JSON.stringify(page.bubbles.map((b) => ({
    x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
    ocr_lang: bubbleParam(b, "ocrLang"),
    // master overlay visibility is client-side (the «🖌 Mask» toggle); here we send the full mask,
    // excluding only bubbles whose mask is disabled individually
    show_mask: b.showMask !== undefined ? !!b.showMask : true,
    ...maskFields(b),
  }))));
  fd.append("ocr_lang", ocr_lang);
  fd.append("mask_expand", state.settings.maskExpand / 100);
  fd.append("label", page.name);

  const token = (page._maskReq = (page._maskReq || 0) + 1);
  try {
    const r = await fetch("/mask/boxes", { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    if (page._maskReq !== token) return; // frames changed since the request — response is stale
    page.maskDataURL = data.mask_b64 || null;
    page.maskImageEl = data.mask_b64 ? await loadImageEl(data.mask_b64) : null;
    if (page._maskReq !== token) return;
    page._maskComputed = true;            // mask for current frames has been computed (even if empty)
    setMaskPending(page, false);
    if (state.pages[state.active] === page) renderMask();
  } catch (err) {
    console.error("Mask preview error:", err);
    if (page._maskReq === token) setMaskPending(page, false);
  }
}

// Safety net: when navigating to a page with frames whose mask hasn't been computed yet
// (e.g. batch detection), kick off the preview immediately.
function ensureMaskPreview(page) {
  if (!page || page._maskPending || page._maskComputed) return;
  if (page.bubbles.length) scheduleMaskPreview(page, 0);
}

