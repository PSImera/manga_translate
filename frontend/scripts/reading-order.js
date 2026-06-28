"use strict";
// [module] bubble reading order (global numbering) + manual numbering block in the toolbar
// =====================================================================
// bubble reading order (global numbering across all pages)
// =====================================================================
// Reading order from bboxes alone is ambiguous and depends on LAYOUT, not just language:
// regular manga — rows right-to-left; western — rows left-to-right; schedule grids —
// columns left-to-right; 4-koma — columns right-to-left. Strategy is chosen explicitly
// (per-page toggle); default is derived from the global source language.
// Reading order = the order of the page.bubbles array.
const READING_STRATEGIES = ["rows-rtl", "rows-ltr", "cols-ltr", "cols-rtl"];
const SPREAD_RATIO = 1.2; // width/height above this → treat scan as a spread (2 pages)
// Japanese and Chinese manga are traditionally read right-to-left (Korean manhwa — left-to-right)
function isRTL() { return state.settings.sourceLang === "ja" || state.settings.sourceLang === "zh"; }
function defaultStrategy() { return isRTL() ? "rows-rtl" : "rows-ltr"; }
// "" / garbage → auto by language; otherwise one of the 4 explicit strategies
function resolveStrategy(v) { return READING_STRATEGIES.includes(v) ? v : defaultStrategy(); }
function globalStrategy() { return resolveStrategy(state.settings.readingStrategy); }
// effective page strategy: per-page override (if individual mode is on) or global
function pageStrategy(page) {
  if (page && page.readingIndividual) return resolveStrategy(page.readingOrder);
  return globalStrategy();
}
function pageIsSpread(page) {
  return page.spread !== undefined ? page.spread : (page.width >= page.height * SPREAD_RATIO);
}
function bubbleCX(b) { return (b.x1 + b.x2) / 2; }
function bubbleCY(b) { return (b.y1 + b.y2) / 2; }
// spread half that the bubble occupies (0 = read first); used only for row strategies
function spreadHalf(b, page, rtl) {
  if (!pageIsSpread(page)) return 0;
  const left = bubbleCX(b) < page.width / 2;
  return rtl ? (left ? 1 : 0) : (left ? 0 : 1); // ja: right half is read first
}
// returns true if bubble a should be read before b, according to the page's reading strategy
function bubblePrecedes(a, b, page, strat) {
  const [axis, dir] = strat.split("-");
  const rtl = dir === "rtl";
  if (axis === "cols") {
    // columns: same column when horizontal ranges overlap — order top-to-bottom;
    // otherwise order columns by direction (ltr: leftmost first; rtl: rightmost first)
    const ov = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
    const minW = Math.min(a.x2 - a.x1, b.x2 - b.x1) || 1;
    if (ov > 0.3 * minW) return bubbleCY(a) < bubbleCY(b);
    return rtl ? bubbleCX(a) > bubbleCX(b) : bubbleCX(a) < bubbleCX(b);
  }
  // rows: spread half first, then row (by vertical overlap), then direction within the row
  const ha = spreadHalf(a, page, rtl), hb = spreadHalf(b, page, rtl);
  if (ha !== hb) return ha < hb;
  const ov = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  const minH = Math.min(a.y2 - a.y1, b.y2 - b.y1) || 1;
  if (ov > 0.3 * minH) return rtl ? bubbleCX(a) > bubbleCX(b) : bubbleCX(a) < bubbleCX(b);
  return bubbleCY(a) < bubbleCY(b); // higher bubble reads first
}
// sort page frames into reading order (called after detection/re-detection/language/strategy change).
// Sorts an index permutation and applies it to both bubbles and the aligned bubbleTexts.
function sortReadingOrder(page) {
  const strat = pageStrategy(page);
  const order = page.bubbles.map((_, i) => i);
  order.sort((ia, ib) => {
    const a = page.bubbles[ia], b = page.bubbles[ib];
    return bubblePrecedes(a, b, page, strat) ? -1 : bubblePrecedes(b, a, page, strat) ? 1 : 0;
  });
  page.bubbles = order.map((i) => page.bubbles[i]);
  if (page.bubbleTexts && page.bubbleTexts.length === order.length)
    page.bubbleTexts = order.map((i) => page.bubbleTexts[i]);
}

// re-sort all pages (global language change updates the default strategy for pages without an
// individual override). Resets any manually clicked order.
function resortAllReadingOrder() {
  state.pages.forEach((p) => { sortReadingOrder(p); persistPage(p); });
  if (state.pages[state.active]) { refreshBubbleIndices(); renderTexts(); syncBubblePanel(); }
}

// re-sort only the active page (per-page strategy change)
function resortActiveReadingOrder() {
  const page = state.pages[state.active];
  if (!page) return;
  sortReadingOrder(page);
  refreshBubbleIndices();
  renderTexts();
  syncBubblePanel();
  persistPage(page);
}

// expand/collapse the «⬚ Frames» control set (shared by the toggle and number mode)
function setFramesOpen(open) {
  el.frameTools.classList.toggle("hidden", !open);
  el.frameToggle.classList.toggle("active", open);
  state.settings.showFrames = open; saveSettings();
  if (!open) { if (state.addMode) toggleAddMode(); deselect(); deactivateBrush(); }
  if (bubbleLayer) { bubbleLayer.visible(open); bubbleLayer.draw(); }
  renderExpand();
  renderMask();
}

// =====================================================================
// reading order toolbar block: strategy (per-page) + manual click-to-number
// =====================================================================
// Strategy dropdown change: in individual mode affects only this page; otherwise updates the
// global strategy (re-sorts all pages that don't have an individual override).
function onStrategyChange() {
  if (state.numberMode) exitNumberMode();
  const page = state.pages[state.active];
  const v = el.orderStrategy.value || null;
  if (page && page.readingIndividual) {
    page.readingOrder = v;
    resortActiveReadingOrder();
  } else {
    state.settings.readingStrategy = v || ""; saveSettings();
    resortAllReadingOrder();
  }
}

// «this page only» checkbox — enables/disables individual reading order for the active page
function onIndividualToggle() {
  const page = state.pages[state.active];
  if (!page) { el.orderIndividual.checked = false; return; }
  if (state.numberMode) exitNumberMode();
  page.readingIndividual = el.orderIndividual.checked;
  // seed with the current global strategy so the dropdown doesn't appear to jump
  if (page.readingIndividual && !READING_STRATEGIES.includes(page.readingOrder))
    page.readingOrder = state.settings.readingStrategy || null;
  syncOrderTools();
  resortActiveReadingOrder();
}

// sync reading order controls to the active page
function syncOrderTools() {
  const page = state.pages[state.active];
  const indiv = !!(page && page.readingIndividual);
  el.orderIndividual.checked = indiv;
  el.orderIndividual.disabled = !page;
  // dropdown shows either the page's individual strategy or the global one
  el.orderStrategy.value = indiv ? (page.readingOrder || "") : (state.settings.readingStrategy || "");
  el.orderNumber.disabled = !page || !page.bubbles.length;
  el.orderNumber.classList.toggle("active", state.numberMode);
}

let _numClicks = [];   // bubbles in click order during number mode
function toggleNumberMode() {
  if (state.numberMode) { applyNumberMode(); return; }
  const page = state.pages[state.active];
  if (!page || !page.bubbles.length) return;
  if (!state.settings.showFrames) setFramesOpen(true);   // number mode requires visible frames
  if (state.addMode) toggleAddMode();
  deactivateBrush();
  deselect();
  state.numberMode = true;
  _numClicks = [];
  el.orderNumber.classList.add("active");
  el.orderNumber.textContent = I18N.t("order.numberDone", { n: 0 });
  setProgress(I18N.t("order.clickHint"));
  refreshNumberLabels();
}

function exitNumberMode() {
  state.numberMode = false;
  _numClicks = [];
  el.orderNumber.classList.remove("active");
  el.orderNumber.textContent = I18N.t("order.number");
  refreshBubbleIndices();
}

function registerNumberClick(b) {
  const i = _numClicks.indexOf(b);
  if (i >= 0) _numClicks.splice(i, 1);   // second click removes the number
  else _numClicks.push(b);
  el.orderNumber.textContent = I18N.t("order.numberDone", { n: _numClicks.length });
  refreshNumberLabels();
  const page = state.pages[state.active];
  if (page && _numClicks.length === page.bubbles.length) applyNumberMode();  // all bubbles numbered
}

// apply manual order: clicked bubbles in click order, remaining bubbles appended in current order
function applyNumberMode() {
  const page = state.pages[state.active];
  if (page && _numClicks.length) {
    const clicked = _numClicks.filter((b) => page.bubbles.includes(b));
    const rest = page.bubbles.filter((b) => !clicked.includes(b));
    const ordered = clicked.concat(rest);
    const texts = page.bubbleTexts && page.bubbleTexts.length === page.bubbles.length
      ? ordered.map((b) => page.bubbleTexts[page.bubbles.indexOf(b)]) : null;
    page.bubbles = ordered;
    if (texts) page.bubbleTexts = texts;
    persistPage(page);
    setProgress(I18N.t("order.updated"));
  }
  exitNumberMode();
  renderTexts();
}

// labels during number mode: clicked → click number (accent), unclicked → «·» (dimmed)
function refreshNumberLabels() {
  const page = state.pages[state.active];
  if (!page || !bubbleLayer) return;
  bubbleLayer.getChildren().forEach((rect) => {
    if (!rect._bubble || !rect._idxLabel) return;
    const n = _numClicks.indexOf(rect._bubble);
    if (n >= 0) { rect._idxLabel.getText().text(String(n + 1)); rect._idxLabel.getTag().fill("rgba(40,120,220,0.92)"); }
    else { rect._idxLabel.getText().text("·"); rect._idxLabel.getTag().fill("rgba(0,0,0,0.45)"); }
    positionIdxLabel(rect);
  });
  bubbleLayer.draw();
}
// insert a new frame at its natural reading position without disturbing the order of others;
// returns the insertion index
function insertReadingOrder(page, b) {
  const strat = pageStrategy(page);
  let i = page.bubbles.findIndex((e) => bubblePrecedes(b, e, page, strat));
  if (i < 0) i = page.bubbles.length;
  page.bubbles.splice(i, 0, b);
  return i;
}

// total number of frames on all pages before this one — used for global sequential numbering
function pageIndexOffset(page) {
  let off = 0;
  for (const p of state.pages) { if (p === page) break; off += p.bubbles.length; }
  return off;
}
function globalBubbleIndex(page, localIdx) { return pageIndexOffset(page) + localIdx; }

