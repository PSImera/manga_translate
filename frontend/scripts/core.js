"use strict";
// [module] core: constants, state, DOM refs (el), Konva globals, settings

// ---------- constants ----------
const PALETTE = ["#ff3b30", "#34c759", "#0a84ff", "#ffd60a", "#ff2d92", "#00e5ff", "#ffffff"];
const MIN_BOX = 6; // minimum size of a new frame in original pixels

// languages: name — display label, cc — country code for flagcdn.com flag image.
// Emoji flags don't render on Windows, so we use image flags.
const LANG_META = {
  ja: { name: "日本語",      cc: "jp" },
  en: { name: "English",    cc: "gb" },
  ru: { name: "Русский",    cc: "ru" },
  fr: { name: "Français",   cc: "fr" },
  pt: { name: "Português",  cc: "pt" },
  de: { name: "Deutsch",    cc: "de" },
  uk: { name: "Українська", cc: "ua" },
  sv: { name: "Svenska",    cc: "se" },
  it: { name: "Italiano",   cc: "it" },
  pl: { name: "Polski",     cc: "pl" },
  hu: { name: "Magyar",     cc: "hu" },
  es: { name: "Español",    cc: "es" },
  zh: { name: "中文",        cc: "cn" },
  ko: { name: "한국어",       cc: "kr" },
  hi: { name: "हिन्दी",        cc: "in" },
  ar: { name: "العربية",      cc: "sa" },
  he: { name: "עברית",       cc: "il" },
};
// source: Japanese (manga-ocr) + others (EasyOCR; zh→ch_sim); target: all except Japanese.
// ar/he (RTL) are target-only: Hebrew is absent from EasyOCR; Arabic as source is not yet enabled.
const SOURCE_LANGS = ["ja", "zh", "ko", "en", "es", "fr", "de", "pt", "it", "pl", "hu", "sv", "ru", "uk", "hi"];
const TARGET_LANGS = ["ru", "en", "es", "fr", "pt", "de", "uk", "sv", "it", "pl", "hu", "ja", "zh", "ko", "hi", "ar", "he"];
const flagSrc = (cc) => `https://flagcdn.com/20x15/${cc}.png`;
const flagSrcset = (cc) => `https://flagcdn.com/40x30/${cc}.png 2x`;
function langOptionHtml(code) {
  const m = LANG_META[code];
  return `<img class="flag" src="${flagSrc(m.cc)}" srcset="${flagSrcset(m.cc)}" alt="" width="20" height="15">` +
    `<span>${m.name}</span>`;
}

// factory defaults for mask detection parameters (used by the ↺ reset on global controls)
const MASK_DEFAULTS = {
  maskExpand: 20, grow: 3, inset: 2, minArea: 4, centerPriority: true, centerRadius: 10,
};

// Tooltip text for non-obvious parameters: hovering «?» shows the i18n title for data-tip,
// e.g. «expand» → tip.expand. Applied on startup and on language change.
function applyTooltips() {
  document.querySelectorAll(".hint[data-tip]").forEach((h) => {
    h.title = I18N.t("tip." + h.dataset.tip);
  });
}

// ---------- state ----------
const state = {
  pages: [],          // {id, name, imageEl, dataURL, width, height, bubbles, status, statusText,
                      //  resultDataURL, resultImageEl, bubbleTexts, viewMode}
  active: -1,
  addMode: false,
  numberMode: false,  // manual click-to-number mode for bubbles
  selected: null,     // currently selected Konva.Rect
  cancel: false,      // flag to abort the current batch process (detection/translation)
  aborters: new Set(),// AbortControllers for in-flight requests — the stop button aborts all
  detectActive: 0,    // number of detections in flight (zero triggers the "detection done" status)
  settings: loadSettings(),
  fonts: [],          // available render fonts, fetched from /fonts
  fontDefaults: {},   // {lang: font_name} — per-language default font from default_fonts.yaml
};

let _seq = 0;
const nextId = () => `p${++_seq}`;

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const el = {
  srcLangBtn: $("src-lang-btn"), srcLangMenu: $("src-lang-menu"),
  langBtn: $("lang-btn"), langMenu: $("lang-menu"), conf: $("conf"), confOut: $("conf-out"),
  lamaModel: $("lama-model"),
  maskExpand: $("mask-expand"), maskExpandOut: $("mask-expand-out"),
  showExpand: $("show-expand-btn"),
  inpaintPad: $("inpaint-pad"), inpaintPadOut: $("inpaint-pad-out"),
  // mask detection parameters (global defaults)
  grow: $("grow"), growOut: $("grow-out"), inset: $("inset"), insetOut: $("inset-out"),
  minArea: $("min-area"), minAreaOut: $("min-area-out"),
  centerPriority: $("center-priority"),
  centerRadius: $("center-radius"), centerRadiusOut: $("center-radius-out"),
  frameColorBtn: $("frame-color-btn"), maskColorBtn: $("mask-color-btn"),
  maskOpacity: $("mask-opacity"), maskOpacityOut: $("mask-opacity-out"),
  globalFont: $("global-font"), globalFontWeight: $("global-font-weight"), globalFontItalic: $("global-font-italic"),
  globalSize: $("global-size"),
  globalMargin: $("global-margin"), globalAlign: $("global-align"), globalValign: $("global-valign"),
  globalVertical: $("global-vertical"), globalColor: $("global-color"),
  globalStroke: $("global-stroke"), globalStrokeWidth: $("global-stroke-width"),
  globalStrokeColor: $("global-stroke-color"),
  fileInput: $("file-input"), clearAll: $("clear-all"),
  clearConfirm: $("clear-confirm"), clearConfirmBtn: $("clear-confirm-btn"), clearCancel: $("clear-cancel"),
  addModeBtn: $("add-mode"), delBtn: $("del-btn"),
  redetect: $("redetect"),
  // «Frames» toggle — expands the frame control set (mask is nested inside)
  frameToggle: $("frame-toggle"), frameTools: $("frame-tools"),
  // «Mask» toggle — expands the inline brush/color/extra-detection set
  maskToggle: $("mask-toggle"), maskTools: $("mask-tools"),
  brushPaint: $("brush-paint"), brushErase: $("brush-erase"),
  brushSize: $("brush-size"), brushSizeOut: $("brush-size-out"), brushClear: $("brush-clear"),
  brushCursor: $("brush-cursor"), stageWrap: $("stage-wrap"),
  orderStrategy: $("order-strategy"), orderIndividual: $("order-individual"), orderNumber: $("order-number"),
  translatePage: $("translate-page"), translateBubble: $("translate-bubble"), translateAll: $("translate-all"),
  ctxPass: $("ctx-pass"), ctxWindow: $("ctx-window"), ctxPages: $("ctx-pages"), ctxBubbles: $("ctx-bubbles"),
  download: $("download"), downloadAll: $("download-all"), downloadPdf: $("download-pdf"),
  thumbs: $("thumbs"), thumbsToggle: $("thumbs-toggle"), prev: $("prev"), next: $("next"),
  viewToggle: $("view-toggle"), showOriginal: $("show-original"), showResult: $("show-result"),
  zoomIn: $("zoom-in"), zoomOut: $("zoom-out"), zoomReset: $("zoom-reset"), pageName: $("page-name"),
  stageContainer: $("stage-container"), emptyHint: $("empty-hint"),
  texts: $("texts"), textsPanel: $("texts-panel"), textsToggle: $("texts-toggle"),
  backendStatus: $("backend-status"),
  // live status bar + log console
  statusBar: $("status-bar"), statusText: $("status-text"),
  consolePanel: $("console-panel"), consoleLog: $("console-log"),
  consoleClear: $("console-clear"), consoleClose: $("console-close"), cacheClear: $("cache-clear"),
  consoleStop: $("console-stop"),
  // slide-out left panel for individual frame settings
  bubblePanel: $("bubble-panel"), bpToggle: $("bp-toggle"), bpScroll: $("bp-scroll"),
  bpBody: $("bp-body"), bpEmpty: $("bp-empty"),
  bpNum: $("bp-num"),
  bpExpand: $("bp-expand"), bpExpandOut: $("bp-expand-out"),
  bpGrow: $("bp-grow"), bpGrowOut: $("bp-grow-out"),
  bpInset: $("bp-inset"), bpInsetOut: $("bp-inset-out"),
  bpMinArea: $("bp-min-area"), bpMinAreaOut: $("bp-min-area-out"),
  bpCenterPriority: $("bp-center-priority"),
  bpCenterRadius: $("bp-center-radius"), bpCenterRadiusOut: $("bp-center-radius-out"),
  bpInpaintPad: $("bp-inpaint-pad"), bpInpaintPadOut: $("bp-inpaint-pad-out"),
  bpShowExpand: $("bp-show-expand"), bpShowMask: $("bp-show-mask"), bpColorBtn: $("bp-color-btn"),
  bpLangBtn: $("bp-lang-btn"), bpLangMenu: $("bp-lang-menu"),
  bpClearBrushRow: $("bp-clear-brush-row"), bpClearBrush: $("bp-clear-brush"),
  // universal HSV color picker
  colorPicker: $("color-picker"), cpSv: $("cp-sv"), cpSvCursor: $("cp-sv-cursor"),
  cpHue: $("cp-hue"), cpHueCursor: $("cp-hue-cursor"),
  cpSwatch: $("cp-swatch"), cpHex: $("cp-hex"), cpEyedrop: $("cp-eyedrop"),
};

// ---------- Konva ----------
let stage = null, imageLayer = null, expandLayer = null, bubbleLayer = null, maskLayer = null, guideLayer = null, transformer = null;
let scale = 1; // canvas px / original px
let zoom = 1; // view zoom multiplier (1 = fit to width), shared across the session
const PAN_GAP = 48; // gap around the stage in px — allows scrolling past the image edge (= #stage-container padding)
let _stagePageId = null; // page id of the current stage — used to preserve scroll position on rebuild

// HSV color picker state
let _cpH = 0, _cpS = 1, _cpV = 1, _cpOnChange = null, _cpAnchor = null;

// brush/eraser state (diameter is in ORIGINAL pixels)
const brush = { active: false, mode: "paint", size: 20, painting: false, last: null };

// =====================================================================
// settings
// =====================================================================
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem("mt_settings") || "{}"); } catch (_) {}
  return {
    // source language (ja → manga-ocr, otherwise → EasyOCR) and target language.
    // Migrate old "ja|ru" scenario key to separate source/target.
    sourceLang: s.sourceLang || (s.scenario ? s.scenario.split("|")[0] : "ja"),
    targetLang: s.targetLang || (s.scenario ? s.scenario.split("|")[1] : "ru"),
    conf: s.conf ?? 0.25,
    readingStrategy: s.readingStrategy || "",  // global reading order strategy ("" = auto by language)
    lamaModel: s.lamaModel || "big-lama",
    showExpand: s.showExpand ?? false,
    inpaintPad: s.inpaintPad ?? 0,    // inpaint context expansion (dashed border), % of bubble size
    showFrames: s.showFrames ?? true, // whether the «⬚ Frames» control set is expanded
    showMask: s.showMask ?? true,     // whether the mask overlay is shown = «🖌 Mask» set is expanded
    // mask detection parameters (defaults for frames; centerRadius is sent to backend as a fraction)
    maskExpand: s.maskExpand ?? MASK_DEFAULTS.maskExpand,  // stroke expansion, %
    grow: s.grow ?? MASK_DEFAULTS.grow,                    // outward dilation, px
    inset: s.inset ?? MASK_DEFAULTS.inset,                 // inward inset from frame edge, px
    minArea: s.minArea ?? MASK_DEFAULTS.minArea,           // minimum blob area, px²
    centerPriority: s.centerPriority ?? MASK_DEFAULTS.centerPriority,
    centerRadius: s.centerRadius ?? MASK_DEFAULTS.centerRadius,  // central zone radius, %
    frameColor: s.frameColor || PALETTE[2],
    maskColor: s.maskColor || PALETTE[0],  // mask overlay color (tinted client-side)
    maskOpacity: s.maskOpacity ?? 60,      // mask overlay opacity, 0..100 (shared for auto and brush)
    queueCollapsed: s.queueCollapsed ?? false,  // whether the page queue strip is collapsed
    textsCollapsed: s.textsCollapsed ?? false,  // whether the right texts panel is collapsed
    bubbleCollapsed: s.bubbleCollapsed ?? true,  // whether the left bubble panel is collapsed (hidden by default)
    defaultFont: s.defaultFont || "",
    defaultFontWeight: s.defaultFontWeight || "Regular",
    defaultFontItalic: s.defaultFontItalic || false,
    // migrate old level 1-10 to absolute px (old default was 7 → now 36px)
    defaultFontSize: (s.defaultFontSize && s.defaultFontSize > 10) ? s.defaultFontSize : 36,
    defaultMargin: s.defaultMargin ?? 8,
    defaultAlign: s.defaultAlign || "center",
    defaultValign: s.defaultValign || "middle",
    defaultVertical: s.defaultVertical || false,
    textColor: s.textColor || "#000000",
    defaultStroke: s.defaultStroke || false,            // text outline on/off
    defaultStrokeWidth: s.defaultStrokeWidth ?? 2,      // outline thickness, px
    defaultStrokeColor: s.defaultStrokeColor || "#ffffff",
    // LLM context
    useContext: s.useContext ?? true,       // whether to pass any context at all
    contextWindow: s.contextWindow ?? 8,   // «Translate all» page window (0 = unlimited)
    contextPages: s.contextPages ?? 1,     // context for single-page edit (0 = no context)
    contextBubbles: s.contextBubbles ?? 3, // context for single-bubble edit (0 = no context)
  };
}
function saveSettings() {
  localStorage.setItem("mt_settings", JSON.stringify(state.settings));
}

// Per-frame parameters and their corresponding global-default key.
// Inheritance model: when a field is undefined on a frame, the value comes from the global
// settings (toolbar). Once edited in the frame panel it becomes an individual override.
// Reset (↺) deletes the field → inherits again. Each parameter is resolved independently.
const BUBBLE_PARAMS = [
  "ocrLang", "maskExpand", "grow", "inset", "minArea",
  "centerPriority", "centerRadius", "inpaintPad", "showExpand", "showMask", "color",
];

// Effective value of a frame parameter: individual override if set, otherwise global default.
// Some parameters use a different key in global settings than on the frame object.
function bubbleParam(b, key) {
  if (b && b[key] !== undefined) return b[key];
  if (key === "color") return state.settings.frameColor;
  if (key === "ocrLang") return state.settings.sourceLang;  // global source language
  return state.settings[key];
}

