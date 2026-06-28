"""Pipeline orchestrator: page → detection → OCR → inpaint → translation → render.

Returns the final image and intermediate data (for debugging/preview in the frontend).
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

import config
from backend.pipeline import cache, progress
from backend.pipeline.detector import Bubble, get_detector
from backend.pipeline.inpaint import InpaintEngine, MaskParams, build_text_mask, get_engine
from backend.pipeline.ocr import BubbleText, OCRLine, get_reader
from backend.pipeline.renderer import get_renderer
from backend.pipeline.translator import get_translator

# Single worker: pages are processed sequentially; one LLM request per page,
# overlapped with the inpaint of the same page.
_TRANSLATE_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="llm")


@dataclass
class PageResult:
    """Result of processing one page (all images are RGB HxWx3)."""
    result: np.ndarray                      # final page with translation rendered
    clean: Optional[np.ndarray] = None      # page after inpaint
    mask: Optional[np.ndarray] = None       # text mask
    bubbles: List[Bubble] = field(default_factory=list)
    ocr: List[BubbleText] = field(default_factory=list)
    translations: List[str] = field(default_factory=list)


def translate_page(
    image: np.ndarray,
    ocr_lang: Optional[str] = None,
    target_lang: Optional[str] = None,
    conf: float = 0.25,
    lama_model: str = "",
    mask_expand: Optional[float] = None,
    pad_fracs: Optional[List[float]] = None,
    return_intermediate: bool = True,
    bubbles: Optional[List[Bubble]] = None,
    mask_params: Optional[List[MaskParams]] = None,
    ocr_langs: Optional[List[Optional[str]]] = None,
    mask_add: Optional[np.ndarray] = None,
    mask_erase: Optional[np.ndarray] = None,
    context: Optional[List[List[dict]]] = None,
    styles: Optional[List[Optional[dict]]] = None,
    label: Optional[str] = None,
    provided_texts: Optional[List[Optional[str]]] = None,
    edit_mode: bool = False,
) -> PageResult:
    """Full pipeline pass for one page. image — RGB HxWx3.

    bubbles — ready region list (manual UI edits). If provided, the detector is skipped
    and translation runs on exactly these regions; otherwise YOLO detects the bubbles.

    mask_params — per-bubble mask detection parameters. If None, the common mask_expand
    is used for all bubbles.

    mask_add / mask_erase — manual brush/eraser mask from the UI (uint8 0/255, page size):
    add is merged into the mask, erase is subtracted from the final mask before inpaint."""
    progress.set_label(label)
    try:
        return _translate_page(
            image, ocr_lang, target_lang, conf, lama_model, mask_expand, pad_fracs,
            return_intermediate, bubbles, mask_params, ocr_langs,
            mask_add, mask_erase, context, styles, provided_texts, edit_mode,
        )
    finally:
        progress.clear()


def _translate_page(
    image, ocr_lang, target_lang, conf, lama_model, mask_expand, pad_fracs,
    return_intermediate, bubbles, mask_params, ocr_langs,
    mask_add, mask_erase, context, styles=None, provided_texts=None, edit_mode=False,
) -> PageResult:
    ocr_lang = ocr_lang or config.OCR_LANG
    target_lang = target_lang or config.TARGET_LANG
    mask_expand = config.INPAINT_MASK_EXPAND if mask_expand is None else mask_expand

    # 1. Bubble detection (or use the ready list from UI)
    if bubbles is None:
        progress.status("bubble detection")
        bubbles = get_detector().detect(image, conf=conf)
        progress.log(f"detection: found {len(bubbles)} bubbles")
    has_manual = mask_add is not None or mask_erase is not None
    if not bubbles and not has_manual:
        return PageResult(result=image.copy(), clean=image.copy(), bubbles=[])

    # 2. OCR (ocr_langs — per-bubble language; provided_texts — skip OCR)
    ocr_results = _run_ocr(image, bubbles, ocr_lang, ocr_langs, provided_texts)

    # Translation is independent of inpainting: LLM waits on network (I/O),
    # inpaint occupies the GPU (compute). Run LLM in the background and inpaint in parallel.
    # cache.stats is thread-local, so hit counts are read inside the worker.
    translate_future = None
    src_texts: List[str] = []
    if provided_texts is None:
        src_texts = [bt.text for bt in ocr_results]
        translate_future = _TRANSLATE_POOL.submit(
            _translate_job, src_texts, ocr_lang, target_lang, context, edit_mode
        )

    # 3. Inpaint (stroke mask inside bubbles)
    clean, mask = _run_inpaint(
        image, ocr_results, lama_model, mask_expand, mask_params,
        pad_fracs, mask_add, mask_erase, has_manual,
    )

    # 4. Translation: collect the background LLM result (skipped when provided_texts is set).
    if provided_texts is not None:
        translations = [t or "" for t in provided_texts]
    else:
        n_src = sum(1 for t in src_texts if t and t.strip())
        # if inpaint finished before the LLM, show a waiting status
        if not translate_future.done():
            progress.status("translation: waiting for LLM response…", log=False)
        translations, thits = translate_future.result()
        if thits == n_src and n_src:
            progress.log(f"translation: {n_src} replies from cache (LLM skipped)")
        elif thits:
            progress.log(f"translation: response received ({n_src - thits} new, {thits} from cache)")
        else:
            progress.log("translation: response received")

    # 5. Render (per-bubble style: font/size/color; styles aligned with bubbles)
    progress.status("rendering translation")
    items = []
    for i, (bt, tr) in enumerate(zip(ocr_results, translations)):
        st = styles[i] if styles and i < len(styles) else None
        items.append((bt.bubble, tr, st) if st else (bt.bubble, tr))
    result = get_renderer().render(clean, items)

    return PageResult(
        result=result,
        clean=clean if return_intermediate else None,
        mask=mask if return_intermediate else None,
        bubbles=bubbles,
        ocr=ocr_results if return_intermediate else [],
        translations=translations,
    )


def _translate_job(texts, source_lang, target_lang, context, edit_mode=False):
    """LLM translation in a pool worker + cache hit count (tally is thread-local — read here)."""
    h0 = cache.stats("translation")[0]
    out = get_translator().translate_texts(
        texts, source_lang=source_lang, target_lang=target_lang,
        context=context, edit_mode=edit_mode,
    )
    return out, cache.stats("translation")[0] - h0


def _run_ocr(image, bubbles, ocr_lang, ocr_langs, provided_texts):
    """Run OCR on bubbles -> BubbleText list. provided_texts -> stubs (OCR skipped)."""
    if provided_texts is not None:
        progress.log(f"skip OCR: reapplying {len(bubbles)} provided translations")
        return [
            BubbleText(bubble=b, lines=[OCRLine(text="x", conf=1.0, x1=b.x1, y1=b.y1, x2=b.x2, y2=b.y2)])
            for b in bubbles
        ]
    # bar-only pre-status (per-bubble ticks give live feedback); the journal line
    # below is honest about how much came from the OCR cache.
    progress.status(f"OCR: reading text ({len(bubbles)} bubbles)", log=False)
    h0 = cache.stats("ocr")[0]
    if ocr_langs is not None:
        ocr_results = get_reader().read_bubbles_per_lang(image, bubbles, ocr_langs)
    else:
        ocr_results = get_reader().read_bubbles(image, bubbles, lang=ocr_lang)
    hits = cache.stats("ocr")[0] - h0
    found = sum(1 for b in ocr_results if b.text)
    if hits == len(bubbles):
        progress.log(f"OCR: {len(bubbles)} bubbles from cache, text in {found}")
    elif hits:
        progress.log(f"OCR: text found in {found} bubbles ({hits} from cache)")
    else:
        progress.log(f"OCR: text found in {found} bubbles")
    return ocr_results


def _run_inpaint(
    image, ocr_results, lama_model: str, mask_expand, mask_params,
    pad_fracs, mask_add, mask_erase, has_manual,
):
    """Erase text via stroke mask -> (clean, mask)."""
    progress.status("inpaint: removing original text", log=False)
    ih0, im0 = cache.stats("inpaint")
    engine = get_engine(lama_model or config.LAMA_MODEL_NAME)
    all_boxes = [(bt.bubble.x1, bt.bubble.y1, bt.bubble.x2, bt.bubble.y2) for bt in ocr_results]
    if mask_params is None:
        mask = build_text_mask(image, ocr_results, MaskParams(expand=mask_expand))
    else:
        mask = build_text_mask(image, ocr_results, mask_params)
    if mask_add is not None:
        np.maximum(mask, mask_add, out=mask)
    if mask_erase is not None:
        mask = mask * (mask_erase <= 127)
    clean = engine.inpaint(image, mask, bubble_boxes=all_boxes, pad_fracs=pad_fracs)

    ih, im = (s - b for s, b in zip(cache.stats("inpaint"), (ih0, im0)))
    if ih and not im:
        progress.log(f"inpaint: {ih} crops from cache")
    elif ih:
        progress.log(f"inpaint: done ({ih} crops from cache)")
    else:
        progress.log("inpaint: done")
    return clean, mask


def clean_page(
    image: np.ndarray,
    *,
    conf: float = 0.25,
    bubbles: Optional[List[Bubble]] = None,
    ocr_lang: Optional[str] = None,
    ocr_langs: Optional[List[Optional[str]]] = None,
    lama_model: str = "",
    mask_expand: Optional[float] = None,
    pad_fracs: Optional[List[float]] = None,
    mask_params: Optional[List[MaskParams]] = None,
    mask_add: Optional[np.ndarray] = None,
    mask_erase: Optional[np.ndarray] = None,
    label: Optional[str] = None,
) -> PageResult:
    """OCR + inpaint only (GPU pipeline phase): page -> cleaned page + OCR texts.

    No LLM or render — translation and rendering are a separate phase (`translate_render`)
    so inpainting can run ahead in the queue without waiting for the external LLM.
    translations holds the raw OCR texts for the frontend to pass to the translation phase."""
    progress.set_label(label)
    try:
        ocr_lang = ocr_lang or config.OCR_LANG
        mask_expand = config.INPAINT_MASK_EXPAND if mask_expand is None else mask_expand
        if bubbles is None:
            progress.status("bubble detection")
            bubbles = get_detector().detect(image, conf=conf)
            progress.log(f"detection: found {len(bubbles)} bubbles")
        has_manual = mask_add is not None or mask_erase is not None
        if not bubbles and not has_manual:
            return PageResult(result=image.copy(), clean=image.copy(), bubbles=[])

        ocr_results = _run_ocr(image, bubbles, ocr_lang, ocr_langs, None)
        clean, mask = _run_inpaint(
            image, ocr_results, lama_model, mask_expand, mask_params,
            pad_fracs, mask_add, mask_erase, has_manual,
        )
        return PageResult(
            result=clean, clean=clean, mask=mask, bubbles=bubbles,
            ocr=ocr_results, translations=[bt.text for bt in ocr_results],
        )
    finally:
        progress.clear()


def translate_render(
    clean: np.ndarray,
    bubbles: List[Bubble],
    source_texts: List[str],
    *,
    source_lang: Optional[str] = None,
    target_lang: Optional[str] = None,
    context: Optional[List[List[dict]]] = None,
    styles: Optional[List[Optional[dict]]] = None,
    label: Optional[str] = None,
) -> PageResult:
    """LLM + render (external pipeline phase) on an already inpainted page.

    clean — page after inpaint; source_texts — OCR texts from the clean_page phase.
    No inpaint here — only translation and rendering on top of clean."""
    progress.set_label(label)
    try:
        source_lang = source_lang or config.OCR_LANG
        target_lang = target_lang or config.TARGET_LANG
        progress.status("translation: waiting for LLM response…", log=False)
        n_src = sum(1 for t in source_texts if t and t.strip())
        translations, thits = _translate_job(source_texts, source_lang, target_lang, context)
        if thits == n_src and n_src:
            progress.log(f"translation: {n_src} replies from cache (LLM skipped)")
        elif thits:
            progress.log(f"translation: response received ({n_src - thits} new, {thits} from cache)")
        else:
            progress.log("translation: response received")

        progress.status("rendering translation")
        items = []
        for i, (b, tr) in enumerate(zip(bubbles, translations)):
            st = styles[i] if styles and i < len(styles) else None
            items.append((b, tr, st) if st else (b, tr))
        result = get_renderer().render(clean, items)
        return PageResult(result=result, clean=clean, bubbles=bubbles, translations=translations)
    finally:
        progress.clear()
