"""Font family map: languages supported by each font and available weight/style variants.

Coverage determined by font cmap (fontTools). Results cached in font_languages.json.
Edit font_languages.json manually to override auto-detected language lists.
Rebuild (discard manual edits): python -m backend.pipeline.fonts

JSON format:
  {
    "FamilyName": {
      "langs": ["en", "ru", ...],
      "variants": {
        "Regular": "relative/path.ttf",
        "Bold": "relative/path.ttf",
        "Bold Italic": "subfolder/BoldItalic.ttf",
        ...
      },
      "variant_langs": {
        "Regular": ["en", "ru", ...],
        "Bold Italic": ["en", ...]
      }
    }
  }

`langs` = languages of the Regular variant (used for font list filtering).
`variant_langs` = per-variant coverage (used to filter weight/italic options in UI).
Paths relative to FONTS_DIR.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, List, Optional

import config

LANG_SAMPLES: Dict[str, str] = {
    "en": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    "ru": "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    "uk": "АаБбВвГгДдЕеИиОоІіЇїЄєҐґ",
    "de": "ABCabcÄäÖöÜüß",
    "fr": "ABCabcÀàÂâÆæÇçÉéÈèÊêËëÎîÏïÔôŒœÙùÛûÜüŸÿ",
    "pt": "ABCabcÃãÁáÂâÀàÇçÉéÊêÍíÓóÔôÕõÚúÜü",
    "it": "ABCabcÀàÈèÉéÌìÒòÙù",
    "es": "ABCabcÁáÉéÍíÓóÚúÜüÑñ¿¡",
    "pl": "ABCabcĄąĆćĘęŁłŃńÓóŚśŹźŻż",
    "sv": "ABCabcÅåÄäÖö",
    "hu": "ABCabcÁáÉéÍíÓóÖöŐőÚúÜüŰű",
    "ja": "あいうえおかきくけこアイウエオカキクケコ日本語月人大",
    "zh": "的一是不了人我在有他这中大来上国个到说",
    "ko": "가나다라마바사아자차카타파하한국어글",
    "hi": "अआइईउऊएऐओऔकखगघचछजझटठडढणतथदधनपफबभमयरलवशषसह",
    "ar": "ابتثجحخدذرزسشصضطظعغفقكلمنهوي",
    "he": "אבגדהוזחטיכלמנסעפצקרשתךםןףץ",
}

# Canonical weight order for UI display
WEIGHT_ORDER = [
    "Thin", "Ultra Light", "Extra Light", "Light", "Book",
    "Regular", "Condensed", "Medium", "Semi Bold", "Bold",
    "Extra Bold", "Condensed Bold", "Heavy", "Black", "Condensed Black",
]
_WEIGHT_RANK = {w: i for i, w in enumerate(WEIGHT_ORDER)}

_FONT_EXTS = {".ttf", ".otf", ".ttc"}

# Weight keyword → canonical name. Order matters: check specific before general.
_WEIGHT_KEYWORDS = [
    ("ultralight", "Ultra Light"),
    ("extrabold", "Extra Bold"),
    ("extralight", "Extra Light"),
    ("semibold", "Semi Bold"),
    ("condensedblack", "Condensed Black"),
    ("condensedbold", "Condensed Bold"),
    ("condensed", "Condensed"),
    ("thin", "Thin"),
    ("light", "Light"),
    ("book", "Book"),
    ("medium", "Medium"),
    ("heavy", "Heavy"),
    ("black", "Black"),
    ("bold", "Bold"),
    ("roman", "Regular"),
]

_MAP_PATH = config.ASSETS_DIR / "font_languages.json"
_DEFAULT_FONTS_PATH = config.FONTS_DIR / "default_fonts.yaml"

_cache: Optional[Dict[str, dict]] = None
_cmap_cache: Dict[str, set] = {}


def get_default_fonts() -> Dict[str, str]:
    """Load {lang: font_name} from default_fonts.yaml (simple key: value format)."""
    if not _DEFAULT_FONTS_PATH.exists():
        return {}
    result: Dict[str, str] = {}
    for line in _DEFAULT_FONTS_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            k, _, v = line.partition(":")
            k, v = k.strip(), v.strip()
            if k and v:
                result[k] = v
    return result


def _cmap_set(path: str) -> set:
    cp = _cmap_cache.get(path)
    if cp is None:
        from fontTools.ttLib import TTFont
        try:
            font = TTFont(path, fontNumber=0, lazy=True)
            cp = set(font.getBestCmap() or {})
            font.close()
        except Exception:  # noqa: BLE001
            cp = set()
        _cmap_cache[path] = cp
    return cp


def _parse_variant_name(stem: str) -> str:
    """Determine variant name from filename stem (e.g. 'gilroy-bolditalic' → 'Bold Italic')."""
    s = re.sub(r"[\s\-_]", "", stem).lower()
    italic = "italic" in s or "itaicl" in s  # handle known typo in HelveticaNeueCyr
    weight = "Regular"
    for kw, name in _WEIGHT_KEYWORDS:
        if kw in s:
            weight = name
            break
    if italic:
        return "Italic" if weight == "Regular" else f"{weight} Italic"
    return weight


def _scan_families() -> Dict[str, Dict[str, str]]:
    """Scan FONTS_DIR and return {family_name: {variant_name: relative_path}}."""
    families: Dict[str, Dict[str, str]] = {}
    d = config.FONTS_DIR
    if not d.exists():
        return families

    # Root-level files: each is its own single-variant family
    for f in sorted(d.iterdir()):
        if f.is_file() and f.suffix.lower() in _FONT_EXTS:
            families[f.stem] = {"Regular": f.name}

    # Subfolder families: folder name = family, files = variants
    for sub in sorted(d.iterdir()):
        if not sub.is_dir():
            continue
        variants: Dict[str, str] = {}
        for f in sorted(sub.iterdir()):
            if not (f.is_file() and f.suffix.lower() in _FONT_EXTS):
                continue
            variant = _parse_variant_name(f.stem)
            rel = f.relative_to(d).as_posix()
            if variant in variants:
                variant = f.stem  # fallback: raw stem on collision
            variants[variant] = rel
        if variants:
            families[sub.name] = variants

    return families


def detect_languages(path: str) -> List[str]:
    """Languages whose full marker set is present in the font's cmap."""
    from fontTools.ttLib import TTFont
    try:
        font = TTFont(path, fontNumber=0, lazy=True)
        cmap = font.getBestCmap() or {}
        font.close()
    except Exception:  # noqa: BLE001
        return []
    codepoints = set(cmap.keys())
    return [lang for lang, sample in LANG_SAMPLES.items()
            if all(ord(ch) in codepoints for ch in sample)]


def _write_map(data: Dict[str, dict]) -> None:
    serializable = {
        name: {
            "langs": info["langs"],
            "variants": info["variants"],
            "variant_langs": info.get("variant_langs", {}),
        }
        for name, info in data.items()
    }
    try:
        _MAP_PATH.write_text(
            json.dumps(serializable, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
    except OSError:
        pass


def get_font_map(force: bool = False) -> Dict[str, dict]:
    """Family map: {family: {langs, variants: {variant_name: rel_path}, variant_langs: {name: [langs]}}}.

    Cached in memory and on disk. Rebuilds when font file set changes."""
    global _cache

    current = _scan_families()
    if _cache is not None and not force and set(_cache) == set(current):
        return _cache

    saved: Dict[str, dict] = {}
    if _MAP_PATH.exists() and not force:
        try:
            raw = json.loads(_MAP_PATH.read_text(encoding="utf-8"))
            for k, v in raw.items():
                if isinstance(v, dict):
                    saved[k] = v
        except (OSError, json.JSONDecodeError):
            saved = {}

    result: Dict[str, dict] = {}
    dirty = False

    for family, file_variants in current.items():
        saved_info = saved.get(family, {})
        saved_langs = saved_info.get("langs")
        saved_variants = saved_info.get("variants", {})
        saved_variant_langs: Dict[str, List[str]] = saved_info.get("variant_langs", {})

        # Variants: use saved if paths still match current scan
        if saved_variants and set(saved_variants.values()) == set(file_variants.values()):
            variants = saved_variants
        else:
            variants = file_variants
            if saved_variants:
                dirty = True

        # Family languages (Regular variant); saved_langs may be edited manually in JSON
        if saved_langs is not None:
            langs = saved_langs
        else:
            default_rel = variants.get("Regular") or next(iter(variants.values()), None)
            langs = detect_languages(str(config.FONTS_DIR / default_rel)) if default_rel else []
            dirty = True

        # Per-variant language detection (used by UI to filter weight/italic by target lang)
        variant_langs: Dict[str, List[str]] = {}
        for vname, rel in variants.items():
            if vname in saved_variant_langs:
                variant_langs[vname] = saved_variant_langs[vname]
            else:
                path = config.FONTS_DIR / rel
                variant_langs[vname] = detect_languages(str(path)) if path.exists() else []
                dirty = True

        result[family] = {"langs": langs, "variants": variants, "variant_langs": variant_langs}

    if set(saved) != set(current):
        dirty = True
    if dirty or not _MAP_PATH.exists():
        _write_map(result)

    _cache = result
    return result


def resolve_font_path(
    family: str,
    weight: Optional[str] = None,
    italic: bool = False,
) -> Optional[str]:
    """Resolve (family, weight, italic) to absolute font file path, with fallback."""
    fm = get_font_map()
    info = fm.get(family)
    if not info:
        return None
    variants = info.get("variants", {})
    if not variants:
        return None

    w = weight or "Regular"
    # Candidate variant names from most to least specific
    candidates: List[str] = []
    if italic and w != "Regular":
        candidates.append(f"{w} Italic")
    if italic:
        candidates.append("Italic")
    candidates.append(w)
    if w != "Regular":
        candidates.append("Regular")

    for cand in candidates:
        if cand in variants:
            path = config.FONTS_DIR / variants[cand]
            if path.exists():
                return str(path)

    # Last resort: first available variant
    for rel in variants.values():
        path = config.FONTS_DIR / rel
        if path.exists():
            return str(path)

    return None


def fonts_for_lang(lang: Optional[str]) -> List[str]:
    """Family names supporting the given language (or all if lang is None)."""
    fm = get_font_map()
    if not lang:
        return sorted(fm)
    return sorted(n for n, info in fm.items() if lang in info["langs"])


def pick_font_for_text(text: str, prefer: Optional[List[str]] = None) -> Optional[str]:
    """Absolute path to first font whose cmap covers all characters in text.

    Used for 'auto' font selection so default doesn't produce tofu."""
    if not text:
        return None
    needed = {ord(ch) for ch in text if not ch.isspace()}
    fm = get_font_map()
    order = list(prefer or []) + [n for n in sorted(fm) if n not in (prefer or [])]
    for name in order:
        info = fm.get(name)
        if not info:
            continue
        variants = info.get("variants", {})
        rel_paths = (
            [variants["Regular"]] if "Regular" in variants else []
        ) + [v for k, v in variants.items() if k != "Regular"]
        for rel in rel_paths:
            path = str(config.FONTS_DIR / rel)
            if Path(path).exists() and needed <= _cmap_set(path):
                return path
    return None


if __name__ == "__main__":
    data = get_font_map(force=True)
    for name in sorted(data):
        info = data[name]
        langs = ", ".join(info["langs"]) or "—"
        variants = ", ".join(info["variants"])
        print(f"{name:32} [{langs}]  variants: {variants}")
    print(f"\nSaved: {_MAP_PATH}")
