"use strict";
// [module] queue persistence in IndexedDB (survives tab close)
// =====================================================================
// queue persistence (IndexedDB) — survives tab close
// =====================================================================
// Pages including frames, manual mask edits, and results are stored in IndexedDB
// (dataURL images are too large for localStorage). Each page is a separate record
// keyed by its id; metadata (order + active + id counter) is a separate record.
// Writes are debounced, so frequent frame/brush edits don't stall the UI.
const IDB_NAME = "mt_db", IDB_PAGES = "pages", IDB_META = "meta", IDB_META_KEY = "session";

function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_PAGES)) db.createObjectStore(IDB_PAGES);
      if (!db.objectStoreNames.contains(IDB_META)) db.createObjectStore(IDB_META);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
function _reqP(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}
function _txDone(tx) {
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
async function idbPutPage(p) {
  const db = await idbOpen();
  const tx = db.transaction(IDB_PAGES, "readwrite");
  tx.objectStore(IDB_PAGES).put(serializePage(p), p.id);
  return _txDone(tx);
}
async function idbDelPage(id) {
  const db = await idbOpen();
  const tx = db.transaction(IDB_PAGES, "readwrite");
  tx.objectStore(IDB_PAGES).delete(id);
  return _txDone(tx);
}
async function idbClearPages() {
  const db = await idbOpen();
  const tx = db.transaction(IDB_PAGES, "readwrite");
  tx.objectStore(IDB_PAGES).clear();
  return _txDone(tx);
}
async function idbGetPage(id) {
  const db = await idbOpen();
  return _reqP(db.transaction(IDB_PAGES, "readonly").objectStore(IDB_PAGES).get(id));
}
async function idbPutMeta(m) {
  const db = await idbOpen();
  const tx = db.transaction(IDB_META, "readwrite");
  tx.objectStore(IDB_META).put(m, IDB_META_KEY);
  return _txDone(tx);
}
async function idbGetMeta() {
  const db = await idbOpen();
  return _reqP(db.transaction(IDB_META, "readonly").objectStore(IDB_META).get(IDB_META_KEY));
}

// mid-pipeline status (inpaint/translation in flight) — don't persist as-is
function _transientStatus(p) {
  return p.status === "translating" || p.status === "cleaning" || p.status === "cleaned";
}

// serializable snapshot of a page (images and manual mask edits as dataURLs)
function serializePage(p) {
  return {
    id: p.id, name: p.name, pdfPage: p.pdfPage || null, dataURL: p.dataURL,
    width: p.width, height: p.height,
    bubbles: p.bubbles,
    readingIndividual: !!p.readingIndividual,   // per-page individual reading order mode
    readingOrder: p.readingOrder || null,        // its strategy (when individual mode is on)
    // transient pipeline statuses must not be saved as-is (would get stuck) — normalize
    // by result presence: translated → done, otherwise → ready
    status: _transientStatus(p) ? (p.resultDataURL ? "done" : "ready") : p.status,
    statusText: _transientStatus(p)
      ? (p.resultDataURL ? I18N.t("status.translated") : I18N.t("badge.frames", { count: p.bubbles.length }))
      : p.statusText,
    resultDataURL: p.resultDataURL || null,
    cleanDataURL: p.cleanDataURL || null,
    maskDataURL: p.maskDataURL || null,
    bubbleTexts: p.bubbleTexts || null,
    viewMode: p.viewMode || "original",
    paint: (p.hasPaint && p.paintCanvas) ? p.paintCanvas.toDataURL("image/png") : null,
    erase: (p.hasErase && p.eraseCanvas) ? p.eraseCanvas.toDataURL("image/png") : null,
  };
}

async function dataURLToCanvas(dataURL, w, h) {
  const img = await loadImageEl(dataURL);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c;
}

// restore a page from a snapshot (load images/canvases, convert to runtime form)
async function deserializePage(sp) {
  const imageEl = await loadImageEl(sp.dataURL);
  const page = {
    id: sp.id, name: sp.name, pdfPage: sp.pdfPage || null, imageEl, dataURL: sp.dataURL,
    width: sp.width, height: sp.height,
    bubbles: sp.bubbles || [],
    readingIndividual: !!sp.readingIndividual,
    readingOrder: sp.readingOrder || null,
    status: sp.status || "ready", statusText: sp.statusText || "",
    resultDataURL: sp.resultDataURL || null,
    resultImageEl: sp.resultDataURL ? await loadImageEl(sp.resultDataURL) : null,
    cleanDataURL: sp.cleanDataURL || null,
    maskDataURL: sp.maskDataURL || null,
    maskImageEl: sp.maskDataURL ? await loadImageEl(sp.maskDataURL) : null,
    bubbleTexts: sp.bubbleTexts || null,
    viewMode: sp.viewMode || "original",
    paintCanvas: null, eraseCanvas: null, hasPaint: false, hasErase: false,
  };
  if (sp.paint) { page.paintCanvas = await dataURLToCanvas(sp.paint, sp.width, sp.height); page.hasPaint = true; }
  if (sp.erase) { page.eraseCanvas = await dataURLToCanvas(sp.erase, sp.width, sp.height); page.hasErase = true; }
  return page;
}

// deferred write: accumulate touched pages, then flush them along with meta in one batch
const _pendingPersist = new Set();
let _persistTimer = null;
function persistPage(page) {
  if (!page) return;
  _pendingPersist.add(page);
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(flushPersist, 600);
}
function persistMeta() { flushPersist(); } // meta (order/active) is written inside flushPersist
async function flushPersist() {
  clearTimeout(_persistTimer); _persistTimer = null;
  const pages = [..._pendingPersist]; _pendingPersist.clear();
  try {
    for (const p of pages) if (state.pages.includes(p)) await idbPutPage(p);
    await idbPutMeta({ order: state.pages.map((p) => p.id), active: state.active, seq: _seq });
  } catch (e) { console.warn("Failed to persist progress:", e); }
}

// restore session on page load
async function restoreSession() {
  let meta;
  try { meta = await idbGetMeta(); } catch (_) { return false; }
  if (!meta || !meta.order || !meta.order.length) return false;
  for (const id of meta.order) {
    let sp;
    try { sp = await idbGetPage(id); } catch (_) { continue; }
    if (sp) state.pages.push(await deserializePage(sp));
  }
  if (!state.pages.length) return false;
  _seq = Math.max(meta.seq || 0,
    ...state.pages.map((p) => parseInt(String(p.id).replace(/\D/g, ""), 10) || 0));
  state.active = Math.min(Math.max(0, meta.active ?? 0), state.pages.length - 1);
  // pages that hadn't finished detection before close — restart detection
  // (others carry saved frames/mask from the snapshot, no preview re-request needed)
  state.pages.forEach((p) => { if (p.status === "detecting") detectPage(p); });
  // active page might not have a mask snapshot — compute preview if missing
  const act = state.pages[state.active];
  if (act && act.status !== "detecting" && !act.maskImageEl && act.bubbles.length)
    scheduleMaskPreview(act, 50);
  return true;
}

