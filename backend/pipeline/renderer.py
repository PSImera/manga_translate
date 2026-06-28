"""Render translated text into bubble regions (Pillow).

Text is fitted into the bubble bbox with word wrap. Margin, font size, and alignment
are independent per-bubble style parameters. Drawn on top of the already inpainted page.
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import config


def list_fonts() -> List[dict]:
    """Available font families with languages and variant info."""
    from backend.pipeline.fonts import get_font_map, WEIGHT_ORDER, _WEIGHT_RANK

    fm = get_font_map()
    out = []
    for name, info in sorted(fm.items()):
        variants_map = info.get("variants", {})
        weights: List[str] = []
        has_italic = False
        for v in variants_map:
            is_italic = v.endswith(" Italic") or v == "Italic"
            if is_italic:
                has_italic = True
                # "Bold Italic" → "Bold", "Italic" → "Regular"
                w = v[: -len(" Italic")].strip() if v.endswith(" Italic") else "Regular"
            else:
                w = v
            if w not in weights:
                weights.append(w)
        weights.sort(key=lambda w: _WEIGHT_RANK.get(w, 999))
        out.append({
            "name": name,
            "langs": list(info["langs"]),
            "variants": list(variants_map.keys()),
            "variant_langs": info.get("variant_langs", {}),
            "weights": weights,
            "has_italic": has_italic,
        })
    return out


def _resolve_font(
    name: Optional[str],
    weight: Optional[str] = None,
    italic: bool = False,
) -> Optional[str]:
    if not name:
        return None
    from backend.pipeline.fonts import resolve_font_path
    return resolve_font_path(name, weight, italic)

def _find_font() -> Optional[str]:
    from backend.pipeline.fonts import resolve_font_path
    fonts = list_fonts()
    if fonts:
        return resolve_font_path(fonts[0]["name"])
    candidates = [
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    return None


_font_cache: dict = {}


def _load_font(path: Optional[str], size: int) -> ImageFont.FreeTypeFont:
    key = (path, size)
    f = _font_cache.get(key)
    if f is None:
        if path:
            f = ImageFont.truetype(path, size)
        else:
            try:
                f = ImageFont.load_default(size)
            except TypeError:
                f = ImageFont.load_default()
        _font_cache[key] = f
    return f


# Unicode ranges for RTL scripts (Hebrew, Arabic + presentation forms).
_RTL_RANGES = [
    (0x0590, 0x05FF),  # Hebrew
    (0x0600, 0x06FF),  # Arabic
    (0x0750, 0x077F),  # Arabic Supplement
    (0x08A0, 0x08FF),  # Arabic Extended-A
    (0xFB1D, 0xFDFF),  # Presentation Forms-A (Hebrew/Arabic)
    (0xFE70, 0xFEFF),  # Presentation Forms-B (Arabic)
]


def _parse_color(c, default: Tuple[int, int, int] = (0, 0, 0)) -> Tuple[int, int, int]:
    """HEX string (#rgb/#rrggbb) → RGB tuple. Empty/invalid → default."""
    if not c:
        return default
    s = str(c).lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) != 6:
        return default
    try:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return default


def _is_rtl(text: str) -> bool:
    return any(any(lo <= ord(c) <= hi for lo, hi in _RTL_RANGES) for c in text)


# CJK scripts with no spaces between words — wrap at individual characters.
# Hangul is NOT included: Korean uses spaces, so word-wrap is more correct.
_CJK_RANGES = [
    (0x3000, 0x303F),  # CJK Symbols and Punctuation
    (0x3040, 0x309F),  # Hiragana
    (0x30A0, 0x30FF),  # Katakana
    (0x3400, 0x4DBF),  # CJK Extension A
    (0x4E00, 0x9FFF),  # CJK Unified Ideographs
    (0xF900, 0xFAFF),  # CJK Compatibility Ideographs
    (0xFF00, 0xFFEF),  # Halfwidth and Fullwidth Forms
]


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in _CJK_RANGES)


def _reshape_rtl(text: str) -> str:
    """Arabic: join letters into contextual forms (Hebrew is passed through unchanged).

    Pillow is built without raqm, so we do shaping ourselves. Applied to logical text
    BEFORE word-wrap; bidi line reversal is done separately after wrapping (_bidi_line)."""
    try:
        import arabic_reshaper

        return arabic_reshaper.reshape(text)
    except Exception:  # noqa: BLE001 — library missing or failed: draw as-is
        return text


def _bidi_line(line: str) -> str:
    """Reorder one line into visual RTL order for Pillow rendering."""
    try:
        from bidi.algorithm import get_display

        return get_display(line)
    except Exception:  # noqa: BLE001
        return line


class TextRenderer:
    def __init__(self, font_path: Optional[str] = None):
        self.font_path = font_path or _find_font()

    def _font(self, size: int, path: Optional[str] = None) -> ImageFont.FreeTypeFont:
        return _load_font(path if path is not None else self.font_path, size)

    @staticmethod
    def _tokens(text: str) -> List[Tuple[str, bool]]:
        """Wrap units: (chunk, had_space_before). Latin/Cyrillic words are kept whole;
        each CJK character is its own unit (Chinese/Japanese have no spaces)."""
        out: List[Tuple[str, bool]] = []
        i, n = 0, len(text)
        space_pending = False
        while i < n:
            ch = text[i]
            if ch.isspace():
                space_pending = True
                i += 1
                continue
            if _is_cjk(ch):
                out.append((ch, space_pending))
                i += 1
            else:
                j = i
                while j < n and not text[j].isspace() and not _is_cjk(text[j]):
                    j += 1
                out.append((text[i:j], space_pending))
                i = j
            space_pending = False
        return out

    @classmethod
    def _wrap(cls, draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> List[str]:
        """Word-wrap to max_w. Manual \\n line breaks are always respected as hard breaks;
        each resulting segment is then word-wrapped independently."""
        lines: List[str] = []
        for segment in text.split('\n'):
            cur = ""
            for tok, space_before in cls._tokens(segment):
                sep = " " if (cur and space_before) else ""
                trial = cur + sep + tok
                if cur and draw.textlength(trial, font=font) > max_w:
                    lines.append(cur)
                    cur = tok
                else:
                    cur = trial
            if cur:
                lines.append(cur)
        return lines

    def render(
        self,
        image: np.ndarray,
        items: Sequence[Tuple],
        default_margin: float = 0.08,
        fill: Tuple[int, int, int] = (0, 0, 0),
    ) -> np.ndarray:
        """
        image — RGB page (after inpaint).
        items — (bubble, text) pairs or (bubble, text, style) triples.
            style — dict of independent optional parameters:
            `font` (font family name),
            `font_size` (absolute size in px — independent of bubble size: the same
            font_size gives the same letter height in every bubble. Text wraps at the
            block width but is never shrunk to fit; empty → 36),
            `margin` (inset from bubble edges as a fraction 0..1 per side — defines the
            text block for wrapping; empty → default_margin),
            `align` ("left"|"center"|"right", default center),
            `slant` (rotation of the whole text block in degrees, -90..90; 0 = horizontal),
            `vertical` (top-to-bottom columns, right-to-left — for narrow bubbles with
            vertical writing; ignored for RTL),
            `color` (HEX text color),
            `stroke` (enable text outline), `stroke_width` (outline thickness, px),
            `stroke_color` (HEX outline color, default white).
        Margin and size are INDEPENDENT: wrap width = block (bubble minus margin), while
        font size is absolute (px) and never shrunk to fit the bubble. Long text wraps
        at the block width; if it still overflows, the user lowers the size manually.
        Returns the RGB page with the translated text composited on top."""
        img = Image.fromarray(image).convert("RGB")
        draw = ImageDraw.Draw(img)

        for item in items:
            bubble, text = item[0], item[1]
            style = item[2] if len(item) > 2 else None
            if not text or not text.strip():
                continue
            font_path = None
            font_size_px = 36   # absolute font size cap in px
            margin = default_margin
            align = "center"
            valign = "middle"  # vertical block alignment: top|middle|bottom
            slant = 0.0        # whole-block rotation in degrees
            vertical = False   # top-to-bottom columns, right-to-left
            item_fill = fill
            stroke_w = 0       # text outline thickness in px (0 = no outline)
            stroke_fill = (255, 255, 255)  # outline color
            if style:
                _fname = style.get("font")
                _fweight = style.get("font_weight")
                _fitalic = bool(style.get("font_italic"))
                font_path = _resolve_font(_fname, _fweight, _fitalic)
                # If the italic variant doesn't cover the text's characters, fall back to non-italic
                if font_path and _fitalic and text:
                    from backend.pipeline.fonts import _cmap_set
                    needed = {ord(c) for c in text if not c.isspace()}
                    if needed and not needed <= _cmap_set(font_path):
                        font_path = _resolve_font(_fname, _fweight, False) or font_path
                fs = style.get("font_size")
                if fs:
                    font_size_px = max(6, int(fs))
                mg = style.get("margin")
                if mg is not None:
                    margin = max(0.0, min(0.45, float(mg)))
                al = style.get("align")
                if al in ("left", "center", "right"):
                    align = al
                va = style.get("valign")
                if va in ("top", "middle", "bottom"):
                    valign = va
                sl = style.get("slant")
                if sl is not None:
                    slant = max(-90.0, min(90.0, float(sl)))
                vertical = bool(style.get("vertical"))
                item_fill = _parse_color(style.get("color"), fill)
                if style.get("stroke"):
                    sw = style.get("stroke_width")
                    stroke_w = max(0, int(sw)) if sw is not None else 2
                    stroke_fill = _parse_color(style.get("stroke_color"), (255, 255, 255))
            if font_path is None:
                # "Auto": pick a font whose cmap covers the translation's characters
                # so the default doesn't produce tofu on Ukrainian/German/etc.
                from backend.pipeline.fonts import pick_font_for_text

                font_path = pick_font_for_text(text) or self.font_path

            # RTL (Arabic/Hebrew): shape letters BEFORE word-wrap; line reversal happens below
            rtl = _is_rtl(text)
            draw_text = _reshape_rtl(text) if rtl else text

            # Text block = bubble minus margin on all sides (wrap happens within this block).
            mx = int(bubble.width * margin)
            my = int(bubble.height * margin)
            box_w = max(1, bubble.width - 2 * mx)
            box_h = max(1, bubble.height - 2 * my)

            size = max(6, font_size_px)

            if vertical and not rtl:
                block = self._vertical_block(draw, draw_text, box_w, box_h, size, font_path, item_fill,
                                             valign=valign, stroke_w=stroke_w, stroke_fill=stroke_fill)
                if block is not None:
                    self._place_block(img, bubble, block, slant, valign=valign, my=my, align=align, mx=mx)
                continue

            # Draw at the exact requested size; wrap at block width, no shrinking.
            font = self._font(size, font_path)
            ascent, descent = font.getmetrics()
            line_h = ascent + descent
            lines = self._wrap(draw, draw_text, font, max(1, box_w - 2 * stroke_w))
            if not lines:
                continue
            if rtl:
                # reorder each wrapped line into visual right-to-left order
                lines = [_bidi_line(ln) for ln in lines]

            total_h = line_h * len(lines)

            def _line_x(ln_w: float, origin: float, span: int) -> float:
                if align == "left":
                    return origin
                if align == "right":
                    return origin + span - ln_w
                return origin + (span - ln_w) / 2

            if slant:
                block_w = max(1, int(round(max(draw.textlength(ln, font=font) for ln in lines))))
                # padding so the stroke isn't clipped at layer edges
                layer = Image.new("RGBA", (block_w + 2 * stroke_w, max(1, total_h) + 2 * stroke_w), (0, 0, 0, 0))
                ld = ImageDraw.Draw(layer)
                yy = stroke_w
                for ln in lines:
                    w = ld.textlength(ln, font=font)
                    ld.text((_line_x(w, stroke_w, block_w), yy), ln, font=font, fill=item_fill,
                            stroke_width=stroke_w, stroke_fill=stroke_fill)
                    yy += line_h
                self._place_block(img, bubble, layer, slant, valign=valign, my=my)
            else:
                if valign == "top":
                    y = bubble.y1 + my
                elif valign == "bottom":
                    y = bubble.y1 + my + max(0, box_h - total_h)
                else:
                    y = bubble.y1 + my + max(0, (box_h - total_h) // 2)
                left = bubble.x1 + mx
                for ln in lines:
                    w = draw.textlength(ln, font=font)
                    draw.text((_line_x(w, left, box_w), y), ln, font=font, fill=item_fill,
                              stroke_width=stroke_w, stroke_fill=stroke_fill)
                    y += line_h

        return np.array(img)

    @staticmethod
    def _place_block(
        img: Image.Image,
        bubble,
        block: Image.Image,
        slant: float,
        valign: str = "middle",
        my: int = 0,
        align: str = "center",
        mx: int = 0,
    ) -> None:
        """Place a ready RGBA text block onto img inside the bubble's text area.
        align = left/center/right (horizontal); valign = top/middle/bottom (vertical).
        mx/my = horizontal/vertical margins in px."""
        if slant:
            block = block.rotate(slant, expand=True, resample=Image.BICUBIC)
        # horizontal
        if align == "left":
            px = bubble.x1 + mx
        elif align == "right":
            px = bubble.x2 - mx - block.width
        else:
            px = int(round(bubble.x1 + bubble.width / 2 - block.width / 2))
        # vertical
        if valign == "top":
            py = bubble.y1 + my
        elif valign == "bottom":
            py = bubble.y2 - my - block.height
        else:
            py = int(round(bubble.y1 + bubble.height / 2 - block.height / 2))
        img.paste(block, (int(round(px)), py), block)

    @staticmethod
    def _segment_to_chars(segment: str) -> List[str]:
        """Convert one line of text to a char list with ' ' sentinels for inter-word gaps."""
        result: List[str] = []
        for i, word in enumerate(segment.split()):
            if i > 0:
                result.append(' ')
            result.extend(list(word))
        return result

    @staticmethod
    def _build_vertical_cols(text: str, per_col: int) -> List[List[str]]:
        """Split text into vertical columns without breaking words across column boundaries.

        Words are the atomic wrap unit. A space between words within the same column is kept as
        a ' ' sentinel (rendered as an empty vertical slot). At column boundaries spaces are
        dropped. Words longer than per_col are split at the character level."""
        words = text.split()
        if not words:
            return []
        cols: List[List[str]] = []
        current: List[str] = []
        for word in words:
            word_chars = list(word)
            if not word_chars:
                continue
            if not current:
                while len(word_chars) > per_col:
                    cols.append(word_chars[:per_col])
                    word_chars = word_chars[per_col:]
                current = word_chars
            else:
                # +1 for inter-word space slot
                if len(current) + 1 + len(word_chars) <= per_col:
                    current.append(' ')
                    current.extend(word_chars)
                else:
                    cols.append(current)
                    current = []
                    while len(word_chars) > per_col:
                        cols.append(word_chars[:per_col])
                        word_chars = word_chars[per_col:]
                    current = word_chars
        if current:
            cols.append(current)
        return cols

    def _vertical_block(
        self,
        draw: ImageDraw.ImageDraw,
        text: str,
        box_w: int,
        box_h: int,
        size: int,
        font_path: Optional[str],
        fill: Tuple[int, int, int],
        valign: str = "middle",
        stroke_w: int = 0,
        stroke_fill: Tuple[int, int, int] = (255, 255, 255),
    ) -> Optional[Image.Image]:
        """RGBA layer with text in vertical columns (top-to-bottom, columns right-to-left).

        Manual \\n breaks force column boundaries. Without \\n, columns are built by word-wrap
        with as many chars per column as fit the block height. Font size is absolute (px) —
        not shrunk to fit. valign controls per-column vertical alignment: top|middle|bottom."""
        if not text.strip():
            return None

        forced = '\n' in text

        def _make_cols(per_col: int) -> List[List[str]]:
            if forced:
                return [self._segment_to_chars(seg) for seg in text.split('\n') if seg.strip()]
            return self._build_vertical_cols(text, per_col)

        font = self._font(size, font_path)
        ascent, descent = font.getmetrics()
        ch_h = max(1, ascent + descent)
        per_col = max(1, box_h // ch_h)
        cols = _make_cols(per_col)
        if not cols:
            return None
        visible = [c for col in cols for c in col if c != ' ']
        if not visible:
            return None
        cw = max(1, int(round(max(draw.textlength(c, font=font) for c in visible))))

        ncols = len(cols)
        maxlen = max(len(c) for c in cols)
        # padding so the stroke isn't clipped at layer edges
        layer = Image.new("RGBA", (ncols * cw + 2 * stroke_w, maxlen * ch_h + 2 * stroke_w), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        for j, col in enumerate(cols):
            col_x = (ncols - 1 - j) * cw + stroke_w  # right to left (Japanese tategumi)
            col_len = len(col)
            if valign == "top":
                y0 = stroke_w
            elif valign == "bottom":
                y0 = (maxlen - col_len) * ch_h + stroke_w
            else:                    # middle
                y0 = (maxlen - col_len) * ch_h // 2 + stroke_w
            for k, ch in enumerate(col):
                if ch == ' ':
                    continue  # empty vertical slot between words
                w = ld.textlength(ch, font=font)
                ld.text((col_x + (cw - w) / 2, y0 + k * ch_h), ch, font=font, fill=fill,
                        stroke_width=stroke_w, stroke_fill=stroke_fill)
        return layer


_default_renderer: Optional[TextRenderer] = None


def get_renderer() -> TextRenderer:
    global _default_renderer
    if _default_renderer is None:
        _default_renderer = TextRenderer()
    return _default_renderer
