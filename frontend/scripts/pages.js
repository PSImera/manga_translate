"use strict";
// [module] file/PDF loading, detection, queue thumbnails
// =====================================================================
// file loading
// =====================================================================
function dataURLToBlob(dataURL) {
  const [head, b64] = dataURL.split(",");
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function onFiles(e) {
  const files = [...e.target.files];
  el.fileInput.value = ""; // allow re-selecting the same file
  state.cancel = false;
  const total = files.length;
  let i = 0;
  for (const f of files) {
    if (state.cancel) break;
    i++;
    if (f.type === "application/pdf") {
      setClientStatus(I18N.t("load.pdf", { name: f.name, i, total }));
      await addPdf(f);
    } else if (f.type.startsWith("image/")) {
      setClientStatus(I18N.t("load.images", { i, total }));
      const dataURL = await fileToDataURL(f);
      await addPage(f.name, dataURL);
    }
  }
  setClientStatus(""); // loading finished — status bar is now driven by server events (detection)
}

async function addPdf(file) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  setProgress(I18N.t("pdf.split", { name: file.name }));
  try {
    const r = await fetch("/pdf/split", { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    let i = 1;
    for (const p of data.pages) {
      await addPage(file.name, p.image_b64, i++);
    }
  } catch (err) {
    setProgress(I18N.t("pdf.error", { msg: err.message }), "error");
    return;
  }
  setProgress("");
}

function loadImageEl(dataURL) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = dataURL;
  });
}

async function addPage(name, dataURL, pdfPage = null) {
  const imageEl = await loadImageEl(dataURL);
  const page = {
    id: nextId(), name, pdfPage, imageEl, dataURL,
    width: imageEl.naturalWidth, height: imageEl.naturalHeight,
    bubbles: [], status: "detecting", statusText: I18N.t("status.detecting"),
    resultDataURL: null, resultImageEl: null, maskDataURL: null, maskImageEl: null,
    bubbleTexts: null, viewMode: "original",
    // manual brush/eraser mask edits (orig-res canvas + non-empty flags)
    paintCanvas: null, eraseCanvas: null, hasPaint: false, hasErase: false,
  };
  state.pages.push(page);
  persistPage(page);
  if (state.active < 0) gotoPage(0); else renderThumbs();
  detectPage(page);
}

// =====================================================================
// detection
// =====================================================================
async function detectPage(page) {
  if (state.cancel) { page.status = "ready"; page.statusText = I18N.t("badge.frames", { count: page.bubbles.length }); renderThumbs(); return; }
  if (state.pages[state.active] === page) refreshBusyStatus(); // show «detecting…» immediately, before the server responds
  const fd = new FormData();
  fd.append("file", dataURLToBlob(page.dataURL), page.name + ".png");
  fd.append("conf", state.settings.conf);
  fd.append("label", page.name);
  const ctrl = registerAbort();
  state.detectActive++;
  try {
    const r = await fetch("/detect/json", { method: "POST", body: fd, signal: ctrl.signal });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    page.bubbles = data.bubbles.map((b) =>
      ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, conf: b.conf }));
    sortReadingOrder(page);   // sort frames into reading order (handles ja-RTL and spreads)
    page.status = "ready";
    page.statusText = I18N.t("badge.frames", { count: page.bubbles.length });
  } catch (err) {
    if (err.name === "AbortError") {
      page.status = "ready";
      page.statusText = I18N.t("badge.frames", { count: page.bubbles.length });
    } else {
      page.status = "error";
      page.statusText = I18N.t("status.detectError");
      console.error(err);
    }
  } finally {
    unregisterAbort(ctrl);
    // last detection in the batch finished — show the green «detection done» marker
    if (--state.detectActive <= 0) { state.detectActive = 0; if (!state.cancel) setDoneStatus("detection"); }
  }
  renderThumbs();
  if (state.pages[state.active] === page) buildStage();
  scheduleMaskPreview(page);
}

// re-run the detector on the current page (discards current frames and edits)
async function redetectActive() {
  const page = state.pages[state.active];
  if (!page) return;
  if (page.status === "detecting") return;
  if (page.bubbles.length &&
      !confirm(I18N.t("redetect.confirm")))
    return;
  state.cancel = false;
  state.selected = null;
  renderBubblePanel();
  page.bubbles = [];
  page.status = "detecting";
  page.statusText = I18N.t("status.detecting");
  renderThumbs();
  buildStage();
  await detectPage(page);
}

// =====================================================================
// thumbnails
// =====================================================================
// Thumbnail badge: top line — frame count (persists after detection),
// bottom line — current operation status (detecting…, translating…, translated, error).
function thumbBadgeLines(page) {
  const count = page.bubbles.length;
  const countLine = (count > 0 && page.status !== "detecting") ? I18N.t("badge.frames", { count }) : "";
  let statusLine = "";
  switch (page.status) {
    case "detecting": statusLine = I18N.t("status.detecting"); break;
    case "cleaning": statusLine = I18N.t("status.cleaning"); break;
    case "cleaned": statusLine = I18N.t("status.cleaned"); break;
    case "translating": statusLine = page.statusText || I18N.t("status.translating"); break;
    case "done": statusLine = page._maskPending ? I18N.t("status.mask") : I18N.t("status.translated"); break;
    case "error": statusLine = page.statusText || I18N.t("status.error"); break;
    default: statusLine = page._maskPending ? I18N.t("status.mask") : ""; // ready — badge already says it all
  }
  return { countLine, statusLine };
}

function renderThumbs() {
  el.thumbs.innerHTML = "";
  state.pages.forEach((page, i) => {
    const div = document.createElement("div");
    div.className = "thumb" + (i === state.active ? " active" : "");
    div.addEventListener("click", () => gotoPage(i));

    // drag-and-drop thumbnails to reorder pages (affects global bubble numbering)
    div.draggable = true;
    div.addEventListener("dragstart", (e) => {
      _thumbDragFrom = i; div.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    div.addEventListener("dragend", () => {
      div.classList.remove("dragging");
      el.thumbs.querySelectorAll(".thumb.drag-over").forEach((t) => t.classList.remove("drag-over"));
    });
    div.addEventListener("dragover", (e) => {
      if (_thumbDragFrom === null || _thumbDragFrom === i) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      div.classList.add("drag-over");
    });
    div.addEventListener("dragleave", () => div.classList.remove("drag-over"));
    div.addEventListener("drop", (e) => {
      e.preventDefault(); div.classList.remove("drag-over");
      reorderPages(_thumbDragFrom, i); _thumbDragFrom = null;
    });

    const img = document.createElement("img");
    img.src = page.resultDataURL || page.dataURL;
    img.draggable = false;   // drag the thumbnail div, not the inner image
    div.appendChild(img);

    // progress stripe shown during long operations (detection/inpaint/translation/mask)
    const busy = page.status === "detecting" || page.status === "translating" ||
      page.status === "cleaning" || page._maskPending;
    if (busy) {
      const bar = document.createElement("div");
      bar.className = "thumb-progress";
      bar.appendChild(document.createElement("span"));
      div.appendChild(bar);
    }

    const { countLine, statusLine } = thumbBadgeLines(page);
    if (countLine || statusLine) {
      const badge = document.createElement("div");
      badge.className = "badge " +
        (page.status === "done" ? "done" : page.status === "error" ? "err"
          : busy ? "busy" : "");
      if (countLine) {
        const c = document.createElement("div");
        c.className = "badge-count"; c.textContent = countLine;
        badge.appendChild(c);
      }
      if (statusLine) {
        const s = document.createElement("div");
        s.className = "badge-status"; s.textContent = statusLine;
        badge.appendChild(s);
      }
      div.appendChild(badge);
    }

    const rm = document.createElement("button");
    rm.className = "remove"; rm.textContent = "×"; rm.title = I18N.t("thumb.remove");
    rm.addEventListener("click", (e) => { e.stopPropagation(); removePage(i); });
    div.appendChild(rm);

    el.thumbs.appendChild(div);
  });
  applyQueueCollapsed();
}

// whether the page queue strip is collapsed (frees vertical space for the canvas).
// The toggle strip is always visible; the arrow shows direction + page count.
function applyQueueCollapsed() {
  const collapsed = state.settings.queueCollapsed;
  el.thumbs.classList.toggle("collapsed", collapsed);
  const n = state.pages.length;
  el.thumbsToggle.textContent = (collapsed ? "▾ " : "▴ ") + I18N.t("queue.label", { count: n });
}

// source index for the drag-and-drop reorder
let _thumbDragFrom = null;

// move page from position `from` to `to`; the active page stays the same
function reorderPages(from, to) {
  if (from === null || to === null || from === to) return;
  if (from < 0 || from >= state.pages.length || to < 0 || to >= state.pages.length) return;
  const activePage = state.pages[state.active];
  const [moved] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, moved);
  state.active = state.pages.indexOf(activePage);
  renderThumbs();
  buildStage();      // recalculates global indices (offset depends on page order)
  persistMeta();
}

function removePage(i) {
  const removed = state.pages[i];
  state.pages.splice(i, 1);
  if (removed) idbDelPage(removed.id).catch(() => {});
  if (state.pages.length === 0) {
    state.active = -1;
  } else if (state.active >= state.pages.length) {
    state.active = state.pages.length - 1;
  } else if (i < state.active) {
    state.active -= 1;
  }
  renderThumbs();
  buildStage();
  persistMeta();
}

// Clear the entire queue (with confirmation). Popover attached to the 🗑 button.
function toggleClearConfirm() {
  if (!el.clearConfirm.classList.contains("hidden")) { closeClearConfirm(); return; }
  el.clearConfirm.classList.remove("hidden");
  const ar = el.clearAll.getBoundingClientRect();
  const pw = el.clearConfirm.offsetWidth || 240;
  const left = Math.max(8, Math.min(window.innerWidth - pw - 8, ar.left));
  el.clearConfirm.style.left = left + "px";
  el.clearConfirm.style.top = (ar.bottom + 6) + "px";
}
function closeClearConfirm() {
  el.clearConfirm.classList.add("hidden");
}
function clearAllPages() {
  state.pages = [];
  state.active = -1;
  state.selected = null;
  renderBubblePanel();
  idbClearPages().catch(() => {});
  renderThumbs();
  buildStage();
  persistMeta();
  setProgress(I18N.t("queue.cleared"));
}

