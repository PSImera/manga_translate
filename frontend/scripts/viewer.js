"use strict";
// [module] page navigation, zoom/pan, page name
// =====================================================================
// navigation
// =====================================================================
function gotoPage(i) {
  if (i < 0 || i >= state.pages.length) return;
  if (state.numberMode) exitNumberMode();   // number mode is tied to the current page
  state.active = i;
  state.selected = null;
  renderThumbs();
  buildStage();
  ensureMaskPreview(state.pages[i]);   // mask not yet computed (e.g. batch detection) — compute it
  refreshBusyStatus();                 // status bar reflects the new active page's phase
  persistMeta();
}

function setViewMode(mode) {
  const page = state.pages[state.active];
  if (!page) return;
  page.viewMode = mode;
  el.showOriginal.classList.toggle("active", mode === "original");
  el.showResult.classList.toggle("active", mode === "result");
  buildStage();
  persistPage(page);
}

// View zoom: 1 = fit to width, more = zoom in (container scrolls).
function clampZoom(z) { return Math.min(4, Math.max(0.05, z)); }

// Button zoom — focus at the viewport center (page stays horizontally centered).
function setZoom(z) {
  const c = el.stageContainer;
  const r = c.getBoundingClientRect();
  zoomAt(z, r.left + c.clientWidth / 2, r.top + c.clientHeight / 2);
}

// Zoom toward a screen point (clientX/clientY): the point under the cursor/center stays fixed.
function zoomAt(z, clientX, clientY) {
  const c = el.stageContainer;
  const r = c.getBoundingClientRect();
  const fx = clientX - r.left, fy = clientY - r.top; // focus point in viewport coordinates
  const o = viewportToOrig(fx, fy);                  // what's under the focus in original coords
  zoom = clampZoom(z);
  el.zoomReset.textContent = Math.round(zoom * 100) + "%";
  buildStage();
  restoreOrigAt(o.x, o.y, fx, fy);                   // put the same original point back under focus
}

// Position of the content's top-left corner relative to the viewport's border-box.
// The stage has a PAN_GAP border (container padding); flex layout field = clientW − 2·GAP.
// When overflowing (stage larger than field): scroll applies, edge = GAP − scroll;
// otherwise the stage is flex-centered inside the field, edge = GAP + half of empty space.
function contentOffset() {
  const c = el.stageContainer;
  const innerW = c.clientWidth - 2 * PAN_GAP, innerH = c.clientHeight - 2 * PAN_GAP;
  const w = stage ? stage.width() : innerW, h = stage ? stage.height() : innerH;
  return {
    left: w > innerW ? PAN_GAP - c.scrollLeft : PAN_GAP + (innerW - w) / 2,
    top: h > innerH ? PAN_GAP - c.scrollTop : PAN_GAP + (innerH - h) / 2,
  };
}

// Viewport point (fx,fy) → original image coordinates.
function viewportToOrig(fx, fy) {
  const off = contentOffset();
  return { x: (fx - off.left) / scale, y: (fy - off.top) / scale };
}

// Scroll so that original point (ox,oy) lands under viewport point (fx,fy).
// From L = fx − ox·scale and L = GAP − scroll: scroll = ox·scale − fx + GAP. Browser clamps to [0,max].
// If content fits along an axis it is centered — no scroll needed (skip).
function restoreOrigAt(ox, oy, fx, fy) {
  const c = el.stageContainer;
  if (stage.width() > c.clientWidth - 2 * PAN_GAP) c.scrollLeft = ox * scale - fx + PAN_GAP;
  if (stage.height() > c.clientHeight - 2 * PAN_GAP) c.scrollTop = oy * scale - fy + PAN_GAP;
}

// Viewport height = from the container top to the bottom of the window (minus a small gap).
function fitContainerHeight() {
  const top = el.stageContainer.getBoundingClientRect().top;
  el.stageContainer.style.height = Math.max(200, window.innerHeight - top - 16) + "px";
}

// Ctrl+wheel — zoom toward cursor (prevents browser page zoom).
// Middle mouse button drag — pan; bounds are clipped by native scroll.
function setupZoomPan() {
  const c = el.stageContainer;
  c.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;                 // plain wheel — native vertical scroll
    e.preventDefault();                     // prevent browser page zoom
    if (!stage) return;
    zoomAt(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
  }, { passive: false });

  // suppress Windows auto-scroll on middle click
  c.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });

  let pan = null;
  c.addEventListener("pointerdown", (e) => {
    if (e.button !== 1) return;             // middle button only
    e.preventDefault();
    pan = { x: e.clientX, y: e.clientY, sl: c.scrollLeft, st: c.scrollTop };
    try { c.setPointerCapture(e.pointerId); } catch (_) {}
    c.classList.add("panning");
  });
  c.addEventListener("pointermove", (e) => {
    if (!pan) return;
    c.scrollLeft = pan.sl - (e.clientX - pan.x); // drag mouse → content follows
    c.scrollTop = pan.st - (e.clientY - pan.y);
  });
  const endPan = (e) => {
    if (!pan) return;
    pan = null; c.classList.remove("panning");
    try { c.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  c.addEventListener("pointerup", endPan);
  c.addEventListener("pointercancel", endPan);
}

// File name in the viewer bar (muted); for PDFs the page index [i] is shown in accent color.
function renderPageName(page) {
  el.pageName.textContent = "";
  if (!page) { el.pageName.title = ""; return; }
  el.pageName.appendChild(document.createTextNode(page.name));
  if (page.pdfPage) {
    const idx = document.createElement("span");
    idx.className = "pdf-idx";
    idx.textContent = ` [${page.pdfPage}]`;
    el.pageName.appendChild(idx);
  }
  el.pageName.title = page.name + (page.pdfPage ? ` [${page.pdfPage}]` : "");
}

