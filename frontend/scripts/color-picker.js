"use strict";
// [module] universal HSV color picker (square + hue slider + hex + eyedropper)
// =====================================================================
// universal HSV picker (saturation/value square + hue slider)
// =====================================================================
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, mx ? d / mx : 0, mx];
}
function cpHexValue() {
  const [r, g, b] = hsvToRgb(_cpH, _cpS, _cpV);
  return rgbToHex(r, g, b);
}

function renderColorPicker() {
  el.cpSv.style.background =
    `linear-gradient(to top, #000, rgba(0,0,0,0)),` +
    `linear-gradient(to right, #fff, rgba(255,255,255,0)),` +
    `hsl(${_cpH}, 100%, 50%)`;
  const w = el.cpSv.clientWidth || 170, h = el.cpSv.clientHeight || 140;
  el.cpSvCursor.style.left = (_cpS * w) + "px";
  el.cpSvCursor.style.top = ((1 - _cpV) * h) + "px";
  const hh = el.cpHue.clientHeight || 140;
  el.cpHueCursor.style.top = ((_cpH / 360) * hh) + "px";
  const hex = cpHexValue();
  el.cpSwatch.style.background = hex;
  if (document.activeElement !== el.cpHex) el.cpHex.value = hex;
}
function emitColor() {
  renderColorPicker();
  if (_cpOnChange) _cpOnChange(cpHexValue());
}

function initColorPicker() {
  // eyedropper: pick a color from the screen (manga page on canvas) via the native EyeDropper API
  if (window.EyeDropper) {
    el.cpEyedrop.addEventListener("click", async () => {
      try {
        const res = await new EyeDropper().open();
        if (res && res.sRGBHex) {
          const [r, g, b] = hexToRgb(res.sRGBHex); [_cpH, _cpS, _cpV] = rgbToHsv(r, g, b); emitColor();
        }
      } catch (_) { /* user cancelled the eyedropper */ }
    });
  } else {
    el.cpEyedrop.classList.add("hidden");  // EyeDropper API unavailable (non-Chromium)
  }

  dragPointer(el.cpSv, (e) => {
    const r = el.cpSv.getBoundingClientRect();
    _cpS = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    _cpV = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    emitColor();
  });
  dragPointer(el.cpHue, (e) => {
    const r = el.cpHue.getBoundingClientRect();
    _cpH = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * 360;
    emitColor();
  });

  el.cpHex.addEventListener("input", () => {
    const v = el.cpHex.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v)) {
      const [r, g, b] = hexToRgb(v); [_cpH, _cpS, _cpV] = rgbToHsv(r, g, b);
      renderColorPicker(); if (_cpOnChange) _cpOnChange(cpHexValue());
    }
  });

  // close on click outside the picker (except trigger buttons) or Escape
  document.addEventListener("pointerdown", (e) => {
    if (el.colorPicker.classList.contains("hidden")) return;
    if (el.colorPicker.contains(e.target) || e.target.closest(".color-btn")) return;
    closeColorPicker();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeColorPicker(); });
}

function dragPointer(elm, onMove) {
  let active = false;
  elm.addEventListener("pointerdown", (e) => {
    active = true; onMove(e); e.preventDefault();
    try { elm.setPointerCapture(e.pointerId); } catch (_) {}
  });
  elm.addEventListener("pointermove", (e) => { if (active) onMove(e); });
  const end = (e) => { active = false; try { elm.releasePointerCapture(e.pointerId); } catch (_) {} };
  elm.addEventListener("pointerup", end);
  elm.addEventListener("pointercancel", end);
}

function openColorPicker(anchor, color, onChange) {
  if (!el.colorPicker.classList.contains("hidden") && _cpAnchor === anchor) {
    closeColorPicker(); return;
  }
  _cpAnchor = anchor; _cpOnChange = onChange;
  const [r, g, b] = hexToRgb(color); [_cpH, _cpS, _cpV] = rgbToHsv(r, g, b);
  el.colorPicker.classList.remove("hidden");
  const ar = anchor.getBoundingClientRect();
  const pw = el.colorPicker.offsetWidth || 224, ph = el.colorPicker.offsetHeight || 200;
  let left = Math.max(8, Math.min(window.innerWidth - pw - 8, ar.left));
  let top = ar.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, ar.top - ph - 6);
  el.colorPicker.style.left = left + "px"; el.colorPicker.style.top = top + "px";
  renderColorPicker();
}
function closeColorPicker() {
  if (el.colorPicker) el.colorPicker.classList.add("hidden");
  _cpOnChange = null; _cpAnchor = null;
}

