"use strict";
// [module] slide-out left panel with individual settings for the selected frame
// =====================================================================
// selected frame settings panel (per-bubble individual settings)
// =====================================================================
function selectedBubble() {
  return state.selected ? state.selected._bubble : null;
}

// Highlight a parameter row: inherited → dimmed without ↺; overridden → bright with active reset.
// Row tooltip: while inherited — generic inheritance hint (bp.hint);
// once overridden — same text as the «?» button for that parameter.
function updateBpRow(b, key) {
  const row = el.bubblePanel.querySelector(`.bp-row[data-param="${key}"]`);
  if (!row) return;
  const isDefault = !b || b[key] === undefined;
  row.classList.toggle("is-default", isDefault);
  const tip = row.querySelector(".hint[data-tip]");
  row.title = isDefault ? I18N.t("bp.hint") : (tip ? I18N.t("tip." + tip.dataset.tip) : "");
}

// panel's own scroll: height = from its top to the window bottom (same as the texts panel),
// so that parameters scroll rather than stretching the page when there's not enough room
function fitBubblePanelHeight() {
  if (!el.bpScroll || state.settings.bubbleCollapsed) return;
  const top = el.bpScroll.getBoundingClientRect().top;
  el.bpScroll.style.maxHeight = Math.max(160, window.innerHeight - top - 16) + "px";
}

// expand/collapse the left panel; arrow indicates direction.
// when collapsed the panel shows nothing even when a frame is selected.
function applyBubbleCollapsed() {
  const collapsed = state.settings.bubbleCollapsed;
  el.bubblePanel.classList.toggle("collapsed", collapsed);
  el.bpToggle.textContent = collapsed ? "›" : "‹";
  if (!collapsed) renderBubblePanel();
  else closeColorPicker();
}

// Fill the expanded panel for the selected frame; without a selection show the hint.
// Does nothing when the panel is collapsed.
function renderBubblePanel() {
  if (state.settings.bubbleCollapsed) return;
  fitBubblePanelHeight();
  const b = selectedBubble();
  el.bpBody.classList.toggle("hidden", !b);
  el.bpEmpty.classList.toggle("hidden", !!b);
  const page = state.pages[state.active];
  if (!b) { el.bpNum.textContent = I18N.t("texts.dash"); if (_cpAnchor === el.bpColorBtn) closeColorPicker(); return; }
  const idx = page ? page.bubbles.indexOf(b) : -1;
  el.bpNum.textContent = idx >= 0 ? `#${globalBubbleIndex(page, idx) + 1}` : I18N.t("texts.dash");
  // show EFFECTIVE values (individual override or inherited default)
  const me = bubbleParam(b, "maskExpand");
  el.bpExpand.value = me; el.bpExpandOut.textContent = `${me}%`;
  const grow = bubbleParam(b, "grow");
  el.bpGrow.value = grow; el.bpGrowOut.textContent = `${grow}px`;
  const inset = bubbleParam(b, "inset");
  el.bpInset.value = inset; el.bpInsetOut.textContent = `${inset}px`;
  const ma = bubbleParam(b, "minArea");
  el.bpMinArea.value = ma; el.bpMinAreaOut.textContent = `${ma}`;
  el.bpCenterPriority.checked = !!bubbleParam(b, "centerPriority");
  const cr = bubbleParam(b, "centerRadius");
  el.bpCenterRadius.value = cr; el.bpCenterRadiusOut.textContent = `${cr}%`;
  const ip = bubbleParam(b, "inpaintPad");
  el.bpInpaintPad.value = ip; el.bpInpaintPadOut.textContent = `${ip}%`;
  el.bpShowExpand.checked = !!bubbleParam(b, "showExpand");
  // inpaint mask for the bubble is on by default (master toggle is «🖌 Mask»)
  el.bpShowMask.checked = b.showMask !== undefined ? !!b.showMask : true;
  el.bpColorBtn.style.background = bubbleParam(b, "color");
  renderBpLang(b);
  BUBBLE_PARAMS.forEach((k) => updateBpRow(b, k));
  // «clear brush edits in frame» row is active only when the bbox actually contains brush strokes
  el.bpClearBrushRow.classList.toggle("is-empty", !bubbleHasBrushEdits(page, b));
  updateCenterRadiusState();
}

// Update the source language button and active option to the effective frame value.
function renderBpLang(b) {
  const code = bubbleParam(b, "ocrLang");
  el.bpLangBtn.innerHTML = langOptionHtml(code) + `<span class="caret">▾</span>`;
  el.bpLangMenu.querySelectorAll(".lang-opt").forEach(
    (o) => o.classList.toggle("active", o.dataset.code === code));
}

// Source language dropdown in the frame panel: selection → per-bubble override.
function initBpLangDropdown() {
  const btn = el.bpLangBtn, menu = el.bpLangMenu;
  menu.innerHTML = SOURCE_LANGS.map(
    (c) => `<button type="button" class="lang-opt" role="option" data-code="${c}">${langOptionHtml(c)}</button>`
  ).join("");
  const close = () => { menu.classList.add("hidden"); btn.setAttribute("aria-expanded", "false"); };
  const open = () => { menu.classList.remove("hidden"); btn.setAttribute("aria-expanded", "true"); };

  menu.querySelectorAll(".lang-opt").forEach((opt) => {
    opt.addEventListener("click", () => {
      const b = selectedBubble();
      if (b) {
        b.ocrLang = opt.dataset.code;       // individual override
        renderBpLang(b);
        updateBpRow(b, "ocrLang");
        scheduleMaskPreview(state.pages[state.active]);
        persistPage(state.pages[state.active]);
      }
      close();
    });
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("hidden")) open(); else close();
  });
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !e.target.closest("#bp-lang-select")) close();
  });
}

// Refresh the open panel for the current frame (called after global default edits
// so that inherited parameters show the updated value).
function syncBubblePanel() {
  renderBubblePanel();
}

// Repaint the stroke of all frames (inherited ones will pick up the new global color).
function refreshBubbleColors() {
  if (!bubbleLayer) return;
  bubbleLayer.getChildren().forEach((rect) => {
    if (rect._bubble) rect.stroke(bubbleParam(rect._bubble, "color"));
  });
  bubbleLayer.draw();
}

function initBubblePanel() {
  // left panel collapse toggle (expanding fills it with the current selection)
  el.bpToggle.addEventListener("click", () => {
    state.settings.bubbleCollapsed = !state.settings.bubbleCollapsed;
    saveSettings();
    applyBubbleCollapsed();
  });
  applyBubbleCollapsed();
  initBpLangDropdown();

  el.bpColorBtn.addEventListener("click", () => {
    const b = selectedBubble(); if (!b) return;
    openColorPicker(el.bpColorBtn, bubbleParam(b, "color"), (c) => {
      b.color = c; el.bpColorBtn.style.background = c; updateBpRow(b, "color");
      if (state.selected) { state.selected.stroke(c); bubbleLayer.draw(); }
      renderExpand(); persistPage(state.pages[state.active]);
    });
  });

  el.bpExpand.addEventListener("input", () => {
    const b = selectedBubble(); if (!b) return;
    b.maskExpand = +el.bpExpand.value; el.bpExpandOut.textContent = `${b.maskExpand}%`;
    updateBpRow(b, "maskExpand"); renderExpand(); scheduleMaskPreview(state.pages[state.active]);
  });
  el.bpGrow.addEventListener("input", () => {
    const b = selectedBubble(); if (!b) return;
    b.grow = +el.bpGrow.value; el.bpGrowOut.textContent = `${b.grow}px`;
    updateBpRow(b, "grow"); renderExpand(); scheduleMaskPreview(state.pages[state.active]);
  });
  el.bpInset.addEventListener("input", () => {
    const b = selectedBubble(); if (!b) return;
    b.inset = +el.bpInset.value; el.bpInsetOut.textContent = `${b.inset}px`;
    updateBpRow(b, "inset"); scheduleMaskPreview(state.pages[state.active]);
  });
  el.bpMinArea.addEventListener("input", () => {
    const b = selectedBubble(); if (!b) return;
    b.minArea = +el.bpMinArea.value; el.bpMinAreaOut.textContent = `${b.minArea}`;
    updateBpRow(b, "minArea"); scheduleMaskPreview(state.pages[state.active]);
  });
  el.bpCenterPriority.addEventListener("change", () => {
    const b = selectedBubble(); if (!b) return;
    b.centerPriority = el.bpCenterPriority.checked; updateBpRow(b, "centerPriority");
    updateCenterRadiusState(); scheduleMaskPreview(state.pages[state.active]);
  });
  el.bpCenterRadius.addEventListener("input", () => {
    const b = selectedBubble(); if (!b) return;
    b.centerRadius = +el.bpCenterRadius.value; el.bpCenterRadiusOut.textContent = `${b.centerRadius}%`;
    updateBpRow(b, "centerRadius"); scheduleMaskPreview(state.pages[state.active]);
  });
  el.bpInpaintPad.addEventListener("input", () => {
    const b = selectedBubble(); if (!b) return;
    b.inpaintPad = +el.bpInpaintPad.value; el.bpInpaintPadOut.textContent = `${b.inpaintPad}%`;
    updateBpRow(b, "inpaintPad"); renderExpand();
    persistPage(state.pages[state.active]);
  });
  el.bpShowExpand.addEventListener("change", () => {
    const b = selectedBubble(); if (!b) return;
    b.showExpand = el.bpShowExpand.checked; updateBpRow(b, "showExpand"); renderExpand();
    persistPage(state.pages[state.active]);
  });
  el.bpShowMask.addEventListener("change", () => {
    const b = selectedBubble(); if (!b) return;
    b.showMask = el.bpShowMask.checked; updateBpRow(b, "showMask");
    scheduleMaskPreview(state.pages[state.active]);
  });

  // ↺ in the action row: clear brush mask edits only within this frame's bbox
  el.bpClearBrush.addEventListener("click", () => {
    const b = selectedBubble(); if (b) clearBubbleEdits(b);
  });

  // ↺ buttons — reset a parameter to default (delete override → inherits again).
  // [data-param] excludes the «clear brush edits» button (handled above).
  el.bubblePanel.querySelectorAll(".bp-reset[data-param]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const b = selectedBubble(); if (!b) return;
      const key = btn.dataset.param;
      delete b[key];
      renderBubblePanel();                      // update values and row highlighting
      if (key === "color") refreshBubbleColors();
      renderExpand();
      scheduleMaskPreview(state.pages[state.active]);
    });
  });
}

