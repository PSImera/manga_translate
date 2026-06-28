"use strict";

// UI localization. Dictionaries live in frontend/i18n/<lang>.json; the selected language
// is remembered in localStorage. Static markup uses data attributes:
//   data-i18n="key"        — sets textContent
//   data-i18n-title="key"  — sets the title attribute
// Dynamic strings in app.js use I18N.t(key, vars), where {name} in the string
// is replaced by vars.name. Language changes trigger window.onUiLangChange().
const I18N = (() => {
  const SUPPORTED = { en: "English", ru: "Русский" };
  const STORE_KEY = "mt_ui_lang";
  let lang = localStorage.getItem(STORE_KEY) || "en";
  if (!SUPPORTED[lang]) lang = "en";
  let dict = {};

  async function load(l) {
    const r = await fetch(`i18n/${l}.json`);
    if (!r.ok) throw new Error(`i18n ${l}: ${r.status}`);
    return r.json();
  }

  function t(key, vars) {
    let s = key in dict ? dict[key] : key;
    if (vars) for (const k in vars) s = s.split(`{${k}}`).join(vars[k]);
    return s;
  }

  // apply dictionary to static markup
  function apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((e) => { e.textContent = t(e.dataset.i18n); });
    root.querySelectorAll("[data-i18n-title]").forEach((e) => { e.title = t(e.dataset.i18nTitle); });
    document.documentElement.lang = lang;
  }

  async function init() {
    dict = await load(lang);
    apply();
  }

  async function setLang(l) {
    if (!SUPPORTED[l] || l === lang) return;
    dict = await load(l);
    lang = l;
    localStorage.setItem(STORE_KEY, l);
    apply();
    if (window.onUiLangChange) window.onUiLangChange();
  }

  // timestamp formatting for the console log — in the active UI language locale
  function timeLocale() { return lang === "ru" ? "ru-RU" : "en-GB"; }

  return {
    t, apply, init, setLang, timeLocale,
    get lang() { return lang; },
    SUPPORTED,
  };
})();
