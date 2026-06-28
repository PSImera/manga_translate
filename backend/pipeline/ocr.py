"""OCR within speech bubbles."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

import config
from backend.pipeline import cache, progress
from backend.pipeline.detector import Bubble


# UI sends 2-letter codes; EasyOCR uses its own codes for some languages (Chinese = ch_sim).
# Most codes match, so we only map exceptions.
_EASY_CODE = {"zh": "ch_sim"}


def _easy_code(lang: str) -> str:
    return _EASY_CODE.get(lang, lang)


@dataclass
class OCRLine:
    """Recognized text fragment in page coordinates."""
    text: str
    conf: float
    x1: int
    y1: int
    x2: int
    y2: int


@dataclass
class BubbleText:
    """OCR result for one bubble."""
    bubble: Bubble
    lines: List[OCRLine] = field(default_factory=list)

    @property
    def text(self) -> str:
        """Bubble text (manga-ocr returns one string per bubble)."""
        return " ".join(ln.text for ln in self.lines if ln.text).strip()


class OCRReader:
    """Engine selected by source language:
    - **Japanese** → manga-ocr (kha-white): trained for vertical/handwritten manga text;
    - **other languages** → EasyOCR by language code (Latin, Cyrillic, etc.).

    Both engines run on torch in the same process as YOLO and LaMa.
    Returns one text string per bubble crop (no per-line coordinates) — each bubble is
    treated as a single line at its bbox. Bubbles without text are skipped (no inpaint or
    translation). Models are loaded lazily and cached per process."""

    def __init__(self, device: Optional[str] = None):
        self.device = (device if device is not None else config.OCR_DEVICE) or ""
        self._mocr = None
        self._easy: dict = {}  # language code -> easyocr.Reader

    @property
    def _gpu(self) -> bool:
        if self.device.lower() == "cpu":
            return False
        import torch
        return torch.cuda.is_available()

    @property
    def mocr(self):
        if self._mocr is None:
            import manga_ocr.ocr as mocr_mod
            from manga_ocr import MangaOcr
            from transformers import AutoImageProcessor
            mocr_mod.AutoFeatureExtractor = AutoImageProcessor
            self._mocr = MangaOcr(force_cpu=self.device.lower() == "cpu")
        return self._mocr

    def _easy_reader(self, lang: str):
        code = _easy_code(lang)
        reader = self._easy.get(code)
        if reader is None:
            import easyocr
            reader = easyocr.Reader([code], gpu=self._gpu)
            self._easy[code] = reader
        return reader

    def ensure(self, langs) -> None:
        """Load OCR models for the given languages. Must be called on the MAIN thread.

        manga-ocr (transformers) crashes with 'Cannot copy out of meta tensor' on first
        load inside a thread-pool worker — instantiate here, then only inference in the pool."""
        for lg in {(l or config.OCR_LANG or "ja").lower() for l in (langs or [])}:
            if lg == "ja":
                _ = self.mocr
            else:
                self._easy_reader(lg)

    def read_bubbles(
        self,
        image: np.ndarray,
        bubbles: List[Bubble],
        lang: Optional[str] = None,
        pad: int = 4,
        **_ignored,
    ) -> List[BubbleText]:
        """image — RGB HxWx3. Returns OCR result for each bubble.

        lang — source language code: "ja" → manga-ocr, otherwise → EasyOCR with that code.
        pad — bbox expansion before cropping."""
        from PIL import Image

        if not bubbles:
            return []

        lang = (lang or config.OCR_LANG or "ja").lower()
        use_manga = lang == "ja"
        easy = None if use_manga else self._easy_reader(lang)

        h, w = image.shape[:2]
        results: List[BubbleText] = []
        total = len(bubbles)
        engine = "manga-ocr" if use_manga else f"EasyOCR ({lang})"
        for n, b in enumerate(bubbles, 1):
            progress.status(f"OCR {engine}: bubble {n}/{total}", log=False)
            x1 = max(0, b.x1 - pad)
            y1 = max(0, b.y1 - pad)
            x2 = min(w, b.x2 + pad)
            y2 = min(h, b.y2 + pad)
            crop = image[y1:y2, x1:x2]
            if crop.size == 0:
                results.append(BubbleText(bubble=b))
                continue

            # cache by crop content + lang: moving a box re-reads, but a re-sent
            # identical crop (debounced preview, page re-translate) is free.
            ckey = cache.digest(repr(crop.shape).encode(), np.ascontiguousarray(crop).tobytes(), lang.encode())
            text = cache.ocr_cache.get(ckey)
            if text is None:
                if use_manga:
                    text = self.mocr(Image.fromarray(crop)).strip()
                else:
                    # paragraph=True merges bubble lines into one block; detail=0 returns text only
                    segs = easy.readtext(crop, detail=0, paragraph=True)
                    text = " ".join(s.strip() for s in segs if s and s.strip()).strip()
                cache.ocr_cache.put(ckey, text)

            lines = (
                [OCRLine(text=text, conf=1.0, x1=b.x1, y1=b.y1, x2=b.x2, y2=b.y2)]
                if text
                else []
            )
            results.append(BubbleText(bubble=b, lines=lines))
        return results

    def read_bubbles_per_lang(
        self,
        image: np.ndarray,
        bubbles: List[Bubble],
        langs: List[Optional[str]],
        pad: int = 4,
    ) -> List[BubbleText]:
        """OCR with a per-bubble language (langs aligned with bubbles).

        Bubbles are grouped by language — one reader pass per language — then
        results are reassembled in the original order."""
        if not bubbles:
            return []
        groups: dict = {}
        for i, lg in enumerate(langs):
            key = (lg or config.OCR_LANG or "ja").lower()
            groups.setdefault(key, []).append(i)

        results: List[Optional[BubbleText]] = [None] * len(bubbles)
        for lg, idxs in groups.items():
            sub = self.read_bubbles(image, [bubbles[i] for i in idxs], lang=lg, pad=pad)
            for i, bt in zip(idxs, sub):
                results[i] = bt
        return [bt for bt in results if bt is not None]


_default_reader: Optional[OCRReader] = None


def get_reader() -> OCRReader:
    global _default_reader
    if _default_reader is None:
        _default_reader = OCRReader()
    return _default_reader
