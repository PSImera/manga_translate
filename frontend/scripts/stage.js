"use strict";
// [module] Konva stage: rendering, frames, selection/move/delete
// =====================================================================
// stage rendering (Konva)
// =====================================================================
function buildStage() {
  const page = state.pages[state.active];
  // stage is rebuilt from scratch — previous rect/transformer references are invalid
  state.selected = null;
  renderBubblePanel();

  el.prev.disabled = state.active <= 0;
  el.next.disabled = state.active < 0 || state.active >= state.pages.length - 1;

  // rebuilding the same page (view change/resize) — preserve the point at the viewport center
  // so the position/scale don't jump; on page change reset to top+center
  let keepFocus = null;
  if (stage && page && _stagePageId === page.id) {
    const c = el.stageContainer;
    keepFocus = viewportToOrig(c.clientWidth / 2, c.clientHeight / 2);
  }

  if (!page) {
    if (stage) { stage.destroy(); stage = null; }
    _stagePageId = null;
    el.stageContainer.replaceChildren();   // remove Konva remnants (they break height/centering)
    el.stageContainer.scrollTo(0, 0);
    fitContainerHeight();   // dark area fills full height even without pages
    el.emptyHint.classList.remove("hidden");
    el.viewToggle.classList.add("hidden");
    renderTexts();          // right panel is always present — shows hint when empty
    renderPageName(null);
    syncOrderTools();   // dropdown reflects global order even when queue is empty
    updateButtons();
    return;
  }
  el.emptyHint.classList.add("hidden");
  // view toggle is always visible when a page is present (even without a translation result)
  el.viewToggle.classList.remove("hidden");
  el.showOriginal.classList.toggle("active", page.viewMode === "original");
  el.showResult.classList.toggle("active", page.viewMode === "result");
  renderPageName(page);

  // right texts panel is always present (like the left panel) — content filled by renderTexts;
  // its width is accounted for in the stage calculation below (flex consumes the space)

  // fixed-height viewport (from container top to window bottom) — required for pan/zoom on both axes;
  // computed BEFORE scale because width depends on the scrollbar presence
  fitContainerHeight();
  // fit to width (zoom=1) INSIDE the PAN_GAP border; zoom>1 zooms in and the container scrolls
  const containerW = (el.stageContainer.clientWidth || 800) - 2 * PAN_GAP;
  scale = (containerW / page.width) * zoom;
  const w = Math.round(page.width * scale);
  const h = Math.round(page.height * scale);

  if (stage) stage.destroy();
  stage = new Konva.Stage({ container: "stage-container", width: w, height: h });
  imageLayer = new Konva.Layer({ listening: false });
  expandLayer = new Konva.Layer({ listening: false });
  bubbleLayer = new Konva.Layer();
  maskLayer = new Konva.Layer({ listening: false }); // mask debug overlay, on top of everything
  guideLayer = new Konva.Layer({ listening: false }); // slant preview (pivot point + horizon line)
  stage.add(imageLayer, expandLayer, bubbleLayer, maskLayer, guideLayer);

  const showResult = page.viewMode === "result" && page.resultImageEl;
  const baseImg = showResult ? page.resultImageEl : page.imageEl;
  imageLayer.add(new Konva.Image({ image: baseImg, width: w, height: h }));
  imageLayer.draw();

  // frames are drawn and editable (select, drag/transform, draw new)
  // in BOTH view modes — original and result
  transformer = new Konva.Transformer({ rotateEnabled: false, keepRatio: false, ignoreStroke: true, padding: 2 });
  bubbleLayer.add(transformer);
  page.bubbles.forEach((b) => addRect(b, true));
  setupStageDrawing();
  // frame visibility is tied to the «⬚ Frames» toggle (collapsed → frames hidden on image)
  bubbleLayer.visible(state.settings.showFrames);
  renderExpand();
  renderMask();
  refreshBubbleIndices();
  bubbleLayer.draw();
  applyBrushInteractivity();

  _stagePageId = page.id;
  // same page — restore the saved focus point; new page — native reset (top, horizontally centered)
  if (keepFocus) restoreOrigAt(keepFocus.x, keepFocus.y, el.stageContainer.clientWidth / 2, el.stageContainer.clientHeight / 2);

  renderTexts();
  syncOrderTools();
  updateButtons();
}

function o2c(v) { return v * scale; }       // original -> canvas
function c2o(v) { return Math.round(v / scale); } // canvas -> original

function addRect(bubble, editable = true) {
  const rect = new Konva.Rect({
    x: o2c(bubble.x1), y: o2c(bubble.y1),
    width: o2c(bubble.x2 - bubble.x1), height: o2c(bubble.y2 - bubble.y1),
    stroke: bubbleParam(bubble, "color"), strokeWidth: 2,
    draggable: editable, listening: editable, name: "bubble",
  });
  rect._bubble = bubble;
  // global index label at the top-left corner of the frame (text set by refreshBubbleIndices)
  const label = new Konva.Label({ listening: false, name: "idx-label" });
  label.add(new Konva.Tag({ fill: "rgba(0,0,0,0.62)", cornerRadius: 2 }));
  label.add(new Konva.Text({ text: "", fontFamily: "monospace", fontSize: 13, fontStyle: "bold", fill: "#fff", padding: 2 }));
  rect._idxLabel = label;
  if (editable) {
    rect.on("click tap", (e) => {
      e.cancelBubble = true;
      if (state.numberMode) { registerNumberClick(rect._bubble); return; }
      selectRect(rect);
    });
    rect.on("dragend transformend", () => writeBack(rect));
    rect.on("dragmove transform", () => positionIdxLabel(rect));
  }
  bubbleLayer.add(rect);
  bubbleLayer.add(label);
  return rect;
}

// place the index label at the top-left corner of the frame
function positionIdxLabel(rect) {
  if (rect._idxLabel) rect._idxLabel.position({ x: rect.x() + 2, y: rect.y() + 2 });
}

// update global index labels for all frames on the active page
// (offset depends on page position in the queue and frame count on preceding pages)
function refreshBubbleIndices() {
  const page = state.pages[state.active];
  if (!page || !bubbleLayer) return;
  const off = pageIndexOffset(page);
  bubbleLayer.getChildren().forEach((rect) => {
    if (!rect._bubble || !rect._idxLabel) return;
    const li = page.bubbles.indexOf(rect._bubble);
    rect._idxLabel.getText().text(li >= 0 ? String(off + li + 1) : "");
    rect._idxLabel.getTag().fill("rgba(0,0,0,0.62)");   // default background (number mode may have recolored it)
    positionIdxLabel(rect);
  });
  bubbleLayer.draw();
}

function selectRect(rect) {
  state.selected = rect;
  transformer.nodes([rect]);
  transformer.moveToTop();
  bubbleLayer.draw();
  renderBubblePanel();
  // sync with texts panel: highlight and scroll to the corresponding row
  const page = state.pages[state.active];
  if (page) highlightTextRow(page.bubbles.indexOf(rect._bubble));
  updateButtons();
}

function deselect() {
  state.selected = null;
  if (transformer) transformer.nodes([]);
  if (bubbleLayer) bubbleLayer.draw();
  renderBubblePanel();
  highlightTextRow(-1);
  updateButtons();
}

function writeBack(rect) {
  // bake transformer scale into dimensions
  const w = Math.max(2, rect.width() * rect.scaleX());
  const h = Math.max(2, rect.height() * rect.scaleY());
  rect.scaleX(1); rect.scaleY(1);
  rect.width(w); rect.height(h);

  const page = state.pages[state.active];
  let x1 = c2o(rect.x()), y1 = c2o(rect.y());
  let x2 = c2o(rect.x() + w), y2 = c2o(rect.y() + h);
  // clip to image bounds
  x1 = Math.max(0, Math.min(page.width, x1));
  y1 = Math.max(0, Math.min(page.height, y1));
  x2 = Math.max(0, Math.min(page.width, x2));
  y2 = Math.max(0, Math.min(page.height, y2));
  const b = rect._bubble;
  b.x1 = Math.min(x1, x2); b.y1 = Math.min(y1, y2);
  b.x2 = Math.max(x1, x2); b.y2 = Math.max(y1, y2);
  positionIdxLabel(rect);
  renderExpand();
  bubbleLayer.draw();
  scheduleMaskPreview(state.pages[state.active]);
}

function deleteSelected() {
  if (!state.selected) return;
  const rect = state.selected;
  const page = state.pages[state.active];
  const idx = page.bubbles.indexOf(rect._bubble);
  if (idx >= 0) {
    page.bubbles.splice(idx, 1);
    // keep texts aligned with frame indices (subsequent indices will shift)
    if (page.bubbleTexts && page.bubbleTexts.length > idx) page.bubbleTexts.splice(idx, 1);
  }
  if (rect._idxLabel) rect._idxLabel.destroy();
  rect.destroy();
  deselect();
  page.status = "ready"; page.statusText = I18N.t("badge.frames", { count: page.bubbles.length });
  renderThumbs();
  renderExpand();
  refreshBubbleIndices();
  renderTexts();
  syncOrderTools();
  bubbleLayer.draw();
  scheduleMaskPreview(page);
}

