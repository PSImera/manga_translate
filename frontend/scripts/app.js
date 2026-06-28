"use strict";
// [module] download, status bar/console (SSE /events), UI language, boot()

// =====================================================================
// download
// =====================================================================
function triggerDownload(dataURL, filename) {
  const a = document.createElement("a");
  a.href = dataURL; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

function downloadActive() {
  const page = state.pages[state.active];
  if (!page || !page.resultDataURL) return;
  triggerDownload(page.resultDataURL, `translated_${page.name}.png`);
}

async function downloadAllZip() {
  const done = state.pages.filter((p) => p.resultDataURL);
  if (done.length === 0) return;
  const zip = new JSZip();
  done.forEach((p, i) => {
    const b64 = p.resultDataURL.split(",")[1];
    zip.file(`${String(i + 1).padStart(3, "0")}_${p.name}.png`, b64, { base64: true });
  });
  setProgress(I18N.t("zip.building"));
  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownload(URL.createObjectURL(blob), "manga_translated.zip");
  setProgress("");
}

async function downloadAllPdf() {
  const done = state.pages.filter((p) => p.resultDataURL);
  if (done.length === 0) return;
  setProgress(I18N.t("pdf.building"));
  const { jsPDF } = window.jspdf;
  let pdf = null;
  for (const p of done) {
    const img = p.resultImageEl || await loadImageEl(p.resultDataURL);
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!pdf) {
      pdf = new jsPDF({ orientation: w >= h ? "landscape" : "portrait", unit: "px", format: [w, h] });
    } else {
      pdf.addPage([w, h], w >= h ? "landscape" : "portrait");
    }
    pdf.addImage(p.resultDataURL, "PNG", 0, 0, w, h);
  }
  pdf.save("manga_translated.pdf");
  setProgress("");
}

// =====================================================================
// misc
// =====================================================================
// client-side messages (PDF parsing, batch translation, render/zip errors) — log console only
// (no need to duplicate them at the download buttons). Backend stages go to the top status bar.
function setProgress(t, level = "info") {
  if (!t) return;
  appendConsole({ ts: Date.now() / 1000, level, msg: t });
}

function updateButtons() {
  const page = state.pages[state.active];
  const hasPage = !!page;
  el.translatePage.disabled = !hasPage;
  // «Translate bubble» — only when a frame is selected on the current page
  el.translateBubble.disabled = !(hasPage && state.selected);
  el.delBtn.disabled = !state.selected;
  // «Result» button is disabled until the page has been translated
  el.showResult.disabled = !(page && page.resultDataURL);
  el.download.disabled = !(page && page.resultDataURL);
  el.translateAll.disabled = state.pages.length === 0;
  const anyResult = state.pages.some((p) => p.resultDataURL);
  el.downloadAll.disabled = !anyResult;
  el.downloadPdf.disabled = !anyResult;
}

async function checkBackend() {
  try {
    const r = await fetch("/health");
    const d = await r.json();
    el.backendStatus.textContent = I18N.t("backend.prefix") + d.model +
      (d.cuda ? I18N.t("backend.cuda") : "") +
      (d.yolo_weights_exist ? "" : I18N.t("backend.noYolo"));
  } catch (_) {
    el.backendStatus.textContent = I18N.t("backend.unavailable");
  }
}

// =====================================================================
// live status bar + log console (SSE /events)
// =====================================================================
const CONSOLE_MAX_LINES = 800;

// The bar has TWO sources: server status (SSE /events — backend pipeline) and
// client status (phases the backend doesn't know about: file reading, PDF parsing before upload).
// Server status takes priority (it's real pipeline work); client status fills the gaps.
let _srvStatus = "";
let _cliStatus = "";
// the last process that finished — shown as a green «… done» badge until the next one starts
let _doneStatus = "";   // "detection" | "translation" | ""

function renderStatusBar() {
  const text = _srvStatus || _cliStatus;
  if (text) {
    el.statusText.textContent = text;
    el.statusText.className = "status-text busy";
  } else if (_doneStatus) {
    // process finished — keep the green «done» badge until the next one starts
    el.statusText.textContent = I18N.t("status.done." + _doneStatus);
    el.statusText.className = "status-done";
  } else {
    el.statusText.textContent = I18N.t("status.idle");
    el.statusText.className = "status-idle";
  }
}

function setStatusBar(text) { _srvStatus = text || ""; renderStatusBar(); }      // from SSE
function setClientStatus(text) { _cliStatus = text || ""; renderStatusBar(); }    // client-side phases
function setDoneStatus(key) { _doneStatus = key || ""; renderStatusBar(); }       // «… done» (green)

// =====================================================================
// stop current process (button in the console)
// =====================================================================
// Register a request's AbortController so «stop» can abort it. The backend won't interrupt
// a page already in progress (torch can't be stopped mid-way), but the frontend stops waiting
// and won't start subsequent pages.
function registerAbort() {
  const c = new AbortController();
  state.aborters.add(c);
  return c;
}
function unregisterAbort(c) { state.aborters.delete(c); }

function stopAllProcesses() {
  state.cancel = true;
  for (const c of state.aborters) { try { c.abort(); } catch (_) {} }
  state.aborters.clear();
  state.detectActive = 0;
  setClientStatus("");
  setProgress(I18N.t("common.stopped"));
}

// Fills «blind» moments between requests (detection → OCR) when the server status has already
// cleared but the next one hasn't arrived yet: shows the active page's phase via client status
// (server status takes priority when present) — so the bar doesn't look dead and it's clear
// that reading isn't possible yet (text not yet recognized).
function refreshBusyStatus() {
  const p = state.pages[state.active];
  let s = "";
  if (p) {
    if (p.status === "detecting") s = I18N.t("status.cliDetecting");
    else if (p.bubbles && p.bubbles.length && p._maskPending) s = I18N.t("status.cliReading");
  }
  setClientStatus(s);
}

function appendConsole(entry) {
  const empty = el.consoleLog.querySelector(".console-empty");
  if (empty) empty.remove();
  const line = document.createElement("div");
  line.className = "console-line" + (entry.level === "error" ? " error" : "");
  const ts = new Date((entry.ts || Date.now() / 1000) * 1000)
    .toLocaleTimeString(I18N.timeLocale(), { hour12: false });
  const tsEl = document.createElement("span");
  tsEl.className = "c-ts"; tsEl.textContent = ts;
  const msgEl = document.createElement("span");
  msgEl.className = "c-msg"; msgEl.textContent = entry.msg;
  line.append(tsEl, msgEl);
  // auto-scroll to bottom if the user is already near the bottom
  const atBottom = el.consoleLog.scrollHeight - el.consoleLog.scrollTop - el.consoleLog.clientHeight < 30;
  el.consoleLog.appendChild(line);
  while (el.consoleLog.childElementCount > CONSOLE_MAX_LINES) el.consoleLog.firstElementChild.remove();
  if (atBottom) el.consoleLog.scrollTop = el.consoleLog.scrollHeight;
}

function toggleConsole(show) {
  const visible = show === undefined ? el.consolePanel.classList.contains("hidden") : show;
  el.consolePanel.classList.toggle("hidden", !visible);
  if (visible) el.consoleLog.scrollTop = el.consoleLog.scrollHeight;
}

function initStatusConsole() {
  el.statusBar.addEventListener("click", () => toggleConsole());
  el.consoleClose.addEventListener("click", () => toggleConsole(false));
  if (el.consoleStop) el.consoleStop.addEventListener("click", stopAllProcesses);
  el.consoleClear.addEventListener("click", () => {
    el.consoleLog.innerHTML = `<div class="console-empty">${I18N.t("console.cleared")}</div>`;
  });
  if (el.cacheClear) el.cacheClear.addEventListener("click", async () => {
    el.cacheClear.disabled = true;
    try {
      const r = await fetch("/cache/clear", { method: "POST" });
      const data = await r.json();
      const c = data.cleared || {};
      appendConsole({ msg: I18N.t("cache.cleared", { ocr: c.ocr || 0, tr: c.translation || 0, inp: c.inpaint || 0 }) });
    } catch (err) {
      appendConsole({ msg: "cache clear failed: " + err, level: "error" });
    } finally {
      el.cacheClear.disabled = false;
    }
  });
  el.consoleLog.innerHTML = `<div class="console-empty">${I18N.t("console.empty")}</div>`;

  // SSE: backend sends {bar, log[]} — update the bar and append lines to the console.
  // EventSource auto-reconnects on disconnect (e.g. server restart).
  try {
    const es = new EventSource("/events");
    es.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (_) { return; }
      if (data.bar !== undefined) setStatusBar(data.bar);
      if (Array.isArray(data.log)) data.log.forEach(appendConsole);
    };
  } catch (err) {
    console.warn("Failed to connect to /events:", err);
  }
}

// ---------- UI language ----------
// dropdown in the header: change → I18N.setLang reloads the dictionary, applies it to markup,
// and calls onUiLangChange to re-render dynamic strings (badges, texts, statuses).
function initUiLang() {
  const sel = document.getElementById("ui-lang");
  sel.value = I18N.lang;
  sel.addEventListener("change", () => I18N.setLang(sel.value));
}

window.onUiLangChange = () => {
  applyTooltips();                       // title for «?» hints (not data-i18n-title)
  populateGlobalFont();                  // «Auto (by text)» label in font list
  fillAlignSelect(el.globalAlign, state.settings.defaultAlign);
  fillValignSelect(el.globalValign, state.settings.defaultValign || "middle");
  checkBackend();                        // backend status line
  renderStatusBar();                     // idle text «▸ console»
  renderThumbs();                        // thumbnail badges (status/count)
  renderTexts();                         // texts panel (heading, button, labels)
  syncBubblePanel();                     // row tooltips in the frame panel (bp.hint / tip.*)
  syncOrderTools();
  // number-mode button label: apply() reset it from data-i18n — restore counter in active mode
  if (state.numberMode) el.orderNumber.textContent = I18N.t("order.numberDone", { n: _numClicks.length });
  updateButtons();
};

// ---------- boot ----------
async function boot() {
  try { await I18N.init(); }             // load dictionary and apply to static markup
  catch (e) { console.warn("i18n failed to load:", e); }  // fallback: t() returns keys, UI still works
  initUiLang();
  initControls();
  initStatusConsole();
  checkBackend();
  loadFonts().then(() => { if (state.pages[state.active]) renderTexts(); });
  // on tab hide/close flush anything that hasn't been written by the debounce yet
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushPersist(); });
  // restore previous session (queue, frames, manual edits) from IndexedDB
  restoreSession()
    .catch((e) => { console.warn("Failed to restore session:", e); return false; })
    .then(() => { renderThumbs(); buildStage(); updateButtons(); });
}
boot();
