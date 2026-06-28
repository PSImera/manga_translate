"""FastAPI endpoints for the manga translation pipeline.

Run with:
    uvicorn backend.app:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
from pathlib import Path
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from starlette.concurrency import run_in_threadpool

import config
from backend.pipeline import progress
from backend.pipeline.detector import Bubble
from backend.pipeline.inpaint import MaskParams
from backend.pipeline.pipeline import clean_page, translate_page, translate_render
from backend.schemas import (
    BBox,
    BubbleResult,
    BubbleSource,
    CleanBoxesResponse,
    DetectJSONResponse,
    FontInfo,
    FontsResponse,
    HealthResponse,
    MaskPreviewResponse,
    PdfPage,
    PdfSplitResponse,
    RenderBoxesResponse,
    TranslateBoxesResponse,
    TranslateJSONResponse,
    TranslateRenderResponse,
)

app = FastAPI(title="Manga Translate", version="0.1.0")

_should_exit = False


def _install_shutdown_hook() -> None:
    global _should_exit
    try:
        import uvicorn
    except Exception:  # noqa: BLE001 — uvicorn may not be installed (import for tests only)
        return
    _orig_handle_exit = uvicorn.Server.handle_exit

    def _handle_exit(self, sig, frame):  # noqa: ANN001
        global _should_exit
        _should_exit = True
        _orig_handle_exit(self, sig, frame)

    uvicorn.Server.handle_exit = _handle_exit


_install_shutdown_hook()

WEB_DIR = Path(__file__).resolve().parent.parent / "frontend"


def _read_image(data: bytes) -> np.ndarray:
    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Failed to read image: {e}"
        )
    return np.array(img)


def _png_bytes(image: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(image).save(buf, format="PNG")
    return buf.getvalue()


def _png_response(image: np.ndarray) -> StreamingResponse:
    return StreamingResponse(io.BytesIO(_png_bytes(image)), media_type="image/png")


def _png_b64(image: np.ndarray) -> str:
    return "data:image/png;base64," + base64.b64encode(_png_bytes(image)).decode("ascii")


def _decode_mask_b64(data: Optional[str], w: int, h: int) -> Optional[np.ndarray]:
    """data:image/png;base64 brush PNG -> uint8 0/255 (255 = painted pixel).

    Uses the alpha channel (brush is drawn with transparency); ignores empty/corrupt masks."""
    if not data:
        return None
    try:
        b64 = data.split(",", 1)[1] if "," in data else data
        img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGBA")
    except Exception:  # noqa: BLE001
        return None
    if img.size != (w, h):
        img = img.resize((w, h))
    alpha = np.array(img)[:, :, 3]
    mask = np.where(alpha > 0, 255, 0).astype(np.uint8)
    return mask if mask.any() else None


def _opt(item: dict, key: str, cast):
    """item[key] cast to type, or None if the field is missing/empty."""
    v = item.get(key)
    return None if v is None else cast(v)


def _parse_boxes(boxes: str, w: int, h: int) -> List[tuple[Bubble, dict]]:
    """Parse the JSON box list from UI into (Bubble, meta) pairs.

    meta holds per-bubble UI settings: show_mask and mask detection params
    (mask_expand, grow, inset, thick_cap, min_area, center_priority, center_radius).
    Coordinates are clipped to image bounds; degenerate boxes are skipped."""
    try:
        raw = json.loads(boxes)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON in boxes: {e}")
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="boxes must be a list of regions")

    out: List[tuple[Bubble, dict]] = []
    for item in raw:
        try:
            x1 = max(0, min(w, int(item["x1"])))
            y1 = max(0, min(h, int(item["y1"])))
            x2 = max(0, min(w, int(item["x2"])))
            y2 = max(0, min(h, int(item["y2"])))
        except (KeyError, TypeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid region: {e}")
        if x2 <= x1 or y2 <= y1:
            continue
        try:
            meta = {
                "ocr_lang": _opt(item, "ocr_lang", str),
                "show_mask": _opt(item, "show_mask", bool),
                "pad": _opt(item, "pad", float),
                "mask_expand": _opt(item, "mask_expand", float),
                "grow": _opt(item, "grow", int),
                "inset": _opt(item, "inset", int),
                "thick_cap": _opt(item, "thick_cap", float),
                "min_area": _opt(item, "min_area", int),
                "center_priority": _opt(item, "center_priority", bool),
                "center_radius": _opt(item, "center_radius", float),
                "font": _opt(item, "font", str),
                "font_weight": _opt(item, "font_weight", str),
                "font_italic": _opt(item, "font_italic", bool),
                "font_size": _opt(item, "font_size", int),
                "margin": _opt(item, "margin", float),
                "align": _opt(item, "align", str),
                "valign": _opt(item, "valign", str),
                "slant": _opt(item, "slant", float),
                "vertical": _opt(item, "vertical", bool),
                "color": _opt(item, "color", str),
                "stroke": _opt(item, "stroke", bool),
                "stroke_width": _opt(item, "stroke_width", int),
                "stroke_color": _opt(item, "stroke_color", str),
                "text": item.get("text") or None,
            }
        except (TypeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid mask parameters: {e}")
        out.append((Bubble(x1=x1, y1=y1, x2=x2, y2=y2, conf=1.0), meta))
    return out


def _parse_context(context: Optional[str]) -> Optional[List[List[dict]]]:
    """Parse the JSON context of previous pages into [{source, translated}] per page.

    Tolerates garbage: invalid JSON or bad elements are ignored — better to translate
    without context than to crash the request."""
    if not context:
        return None
    try:
        raw = json.loads(context)
    except json.JSONDecodeError:
        return None
    if not isinstance(raw, list):
        return None
    pages: List[List[dict]] = []
    for page in raw:
        if not isinstance(page, list):
            continue
        pairs = [
            {"source": item.get("source"), "translated": item.get("translated")}
            for item in page
            if isinstance(item, dict)
        ]
        pages.append(pairs)
    return pages or None


def _mask_params(meta: dict, default_expand: float) -> MaskParams:
    def _get(key, default):
        v = meta.get(key)
        return v if v is not None else default

    return MaskParams(
        expand=_get("mask_expand", default_expand),
        grow=_get("grow", config.INPAINT_GROW),
        inset=_get("inset", config.INPAINT_INSET),
        thick_cap=_get("thick_cap", config.INPAINT_THICK_CAP),
        min_area=_get("min_area", config.INPAINT_MIN_AREA),
        center_priority=_get("center_priority", config.INPAINT_CENTER_PRIORITY),
        center_radius=_get("center_radius", config.INPAINT_CENTER_RADIUS),
    )


def _warmup(*, detector: bool = False, ocr_langs=None, lama_model: str = "") -> None:
    """Load heavy torch models on the MAIN thread before offloading inference to the pool.

    manga-ocr (transformers) crashes with 'Cannot copy out of meta tensor; no data!'
    on first load inside a thread-pool worker — instantiate here once, then inference only."""
    if detector:
        from backend.pipeline.detector import get_detector
        get_detector().ensure()
    if ocr_langs is not None:
        from backend.pipeline.ocr import get_reader
        get_reader().ensure(ocr_langs)
    if lama_model:
        from backend.pipeline.inpaint import get_engine
        get_engine(lama_model).ensure()


async def _ensure_lama_ready(lama_model: str) -> None:
    """Download the LaMa model if not cached yet, reporting status before warmup.

    _warmup blocks the event loop, so the download status must be pushed first:
    set status → sleep(0.25) to let SSE flush → then download (blocking)."""
    import os
    from backend.pipeline.inpaint import _lama_cache_path
    model = lama_model or config.LAMA_MODEL_NAME
    info = config.LAMA_MODELS.get(model, {})
    url = info.get("url", "")
    if url and not os.path.exists(_lama_cache_path(url)):
        label = info.get("label", model)
        progress.status(f"downloading {label} (~200 MB)…", log=True)
        await asyncio.sleep(0.3)
        from backend.pipeline.inpaint import download_lama_model
        download_lama_model(model)


def _mask_overlay_b64(mask: Optional[np.ndarray]) -> Optional[str]:
    """Fill mask (uint8 0/255) -> solid-red RGBA PNG for the UI overlay.

    Alpha is always 255 — the client controls opacity and color, so the auto-mask and
    the manual brush share a single opacity slider."""
    if mask is None or not mask.any():
        return None
    h, w = mask.shape[:2]
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    sel = mask > 127
    rgba[sel] = (255, 0, 0, 255)
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    """Serve SVG favicon so browser's default /favicon.ico request doesn't log a 404."""
    icon = WEB_DIR / "favicon.svg"
    if not icon.exists():
        raise HTTPException(status_code=404)
    return FileResponse(str(icon), media_type="image/svg+xml")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    import torch

    return HealthResponse(
        model=config.MODEL,
        ocr_lang=config.OCR_LANG,
        target_lang=config.TARGET_LANG,
        yolo_weights=str(config.YOLO_WEIGHTS),
        yolo_weights_exist=config.YOLO_WEIGHTS.exists(),
        cuda=torch.cuda.is_available(),
    )


@app.get("/lama-models")
def lama_models_list():
    """List configured LaMa models."""
    return [{"name": name, "label": info["label"]} for name, info in config.LAMA_MODELS.items()]


@app.post("/cache/clear")
def cache_clear() -> dict:
    """Clear in-process pipeline caches (OCR / translation / inpaint)."""
    from backend.pipeline import cache

    return {"cleared": cache.clear_all()}


@app.get("/events")
async def events():
    """SSE stream of pipeline status: current-activity bar + new log lines.

    Heavy stages run in the thread pool, so this event-loop coroutine can push
    progress while processing. On connect, sends the full log history; then only deltas."""
    async def gen():
        last = 0
        last_rev = -1
        try:
            while not _should_exit:
                snap = progress.snapshot(after=last)
                if snap["log"]:
                    last = snap["log"][-1]["seq"]
                if snap["rev"] != last_rev or snap["log"]:
                    last_rev = snap["rev"]
                    payload = json.dumps({"bar": snap["bar"], "log": snap["log"]})
                    yield f"data: {payload}\n\n"
                await asyncio.sleep(0.2)
        except asyncio.CancelledError:
            # Client disconnected or server is shutting down — exit silently.
            pass

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/translate")
async def translate(
    file: UploadFile = File(...),
    ocr_lang: Optional[str] = Form(default=None),
    target_lang: Optional[str] = Form(default=None),
    conf: float = Form(default=0.25),
    lama_model: str = Form(default=""),
    mask_expand: Optional[float] = Form(default=None),
):
    """Page + language params -> finished image (PNG)."""
    image = _read_image(await file.read())
    await _ensure_lama_ready(lama_model)
    _warmup(detector=True, ocr_langs=[ocr_lang or config.OCR_LANG], lama_model=lama_model)
    try:
        res = await run_in_threadpool(
            translate_page,
            image,
            ocr_lang=ocr_lang,
            target_lang=target_lang,
            conf=conf,
            lama_model=lama_model,
            mask_expand=mask_expand,
            return_intermediate=False,
        )
    except RuntimeError as e:
        progress.error(f"translation error: {e}")
        raise HTTPException(status_code=502, detail=str(e))
    return _png_response(res.result)


@app.post("/translate/json", response_model=TranslateJSONResponse)
async def translate_json(
    file: UploadFile = File(...),
    ocr_lang: Optional[str] = Form(default=None),
    target_lang: Optional[str] = Form(default=None),
    conf: float = Form(default=0.25),
    lama_model: str = Form(default=""),
    mask_expand: Optional[float] = Form(default=None),
):
    """Page -> JSON with bboxes, source text, and translation (for debugging)."""
    image = _read_image(await file.read())
    await _ensure_lama_ready(lama_model)
    _warmup(detector=True, ocr_langs=[ocr_lang or config.OCR_LANG], lama_model=lama_model)
    try:
        res = await run_in_threadpool(
            translate_page,
            image,
            ocr_lang=ocr_lang,
            target_lang=target_lang,
            conf=conf,
            lama_model=lama_model,
            mask_expand=mask_expand,
            return_intermediate=True,
        )
    except RuntimeError as e:
        progress.error(f"translation error: {e}")
        raise HTTPException(status_code=502, detail=str(e))

    bubbles = [
        BubbleResult(
            bbox=BBox(
                x1=bt.bubble.x1,
                y1=bt.bubble.y1,
                x2=bt.bubble.x2,
                y2=bt.bubble.y2,
                conf=bt.bubble.conf,
            ),
            source_text=bt.text,
            translated_text=tr,
        )
        for bt, tr in zip(res.ocr, res.translations)
    ]
    h, w = image.shape[:2]
    return TranslateJSONResponse(
        width=w,
        height=h,
        ocr_lang=ocr_lang or config.OCR_LANG,
        target_lang=target_lang or config.TARGET_LANG,
        bubbles=bubbles,
    )


@app.post("/translate/boxes", response_model=TranslateBoxesResponse)
async def translate_boxes(
    file: UploadFile = File(...),
    boxes: str = Form(...),
    ocr_lang: Optional[str] = Form(default=None),
    target_lang: Optional[str] = Form(default=None),
    lama_model: str = Form(default=""),
    mask_expand: Optional[float] = Form(default=None),
    mask_add: Optional[str] = Form(default=None),
    mask_erase: Optional[str] = Form(default=None),
    context: Optional[str] = Form(default=None),
    label: Optional[str] = Form(default=None),
    skip_translate: bool = Form(default=False),
    edit_mode: bool = Form(default=False),
):
    """Translate using a ready region list (manual UI edits) — detector is skipped.

    boxes: JSON string [{"x1":..,"y1":..,"x2":..,"y2":..}, ...] in original image pixels.
    mask_add / mask_erase: manual brush/eraser mask (base64 PNG, same size as the page).
    context: JSON list of already-translated previous pages ([[{"source":..,"translated":..}...],...]);
    injected as past dialogue turns so the LLM sees the full manga context.
    edit_mode: re-translating a single bubble inside an already-translated manga — uses a
    different system prompt and bypasses the translation cache.
    Returns finished PNG (base64) and bubble texts."""
    image = _read_image(await file.read())
    h, w = image.shape[:2]
    parsed = _parse_boxes(boxes, w, h)
    ctx = _parse_context(context)
    bubbles = [b for b, _ in parsed]
    default_expand = config.INPAINT_MASK_EXPAND if mask_expand is None else mask_expand
    default_ocr = ocr_lang or config.OCR_LANG
    mask_params = [_mask_params(m, default_expand) for _, m in parsed]
    ocr_langs = [m["ocr_lang"] or default_ocr for _, m in parsed]
    # inpaint context as a fraction of bubble size (per-bubble, 0 if not set)
    pad_fracs = [m["pad"] if m["pad"] is not None else 0.0 for _, m in parsed]
    # per-bubble render style (font/size/color) — effective values already computed on the frontend
    styles = [
        {"font": m["font"], "font_weight": m["font_weight"], "font_italic": m["font_italic"] or False,
         "font_size": m["font_size"], "margin": m["margin"],
         "align": m["align"], "valign": m["valign"], "slant": m["slant"],
         "vertical": m["vertical"], "color": m["color"],
         "stroke": m["stroke"], "stroke_width": m["stroke_width"], "stroke_color": m["stroke_color"]}
        for _, m in parsed
    ]
    provided_texts = [m["text"] for _, m in parsed] if skip_translate else None
    progress.set_label(label)
    await _ensure_lama_ready(lama_model)
    # Show the first stage on the bar and let SSE flush it before the pool grabs the GIL
    # (torch OCR/inpaint starve the event loop, so statuses set inside the pool lag).
    progress.status(
        "inpaint: removing original text" if skip_translate
        else f"OCR: reading text ({len(bubbles)} bubbles)",
        log=False,
    )
    _warmup(ocr_langs=ocr_langs or [default_ocr], lama_model=lama_model)
    await asyncio.sleep(0.25)

    try:
        res = await run_in_threadpool(
            translate_page,
            image,
            ocr_lang=ocr_lang,
            target_lang=target_lang,
            lama_model=lama_model,
            mask_expand=mask_expand,
            pad_fracs=pad_fracs,
            return_intermediate=True,
            bubbles=bubbles,
            mask_params=mask_params,
            ocr_langs=ocr_langs,
            mask_add=_decode_mask_b64(mask_add, w, h),
            mask_erase=_decode_mask_b64(mask_erase, w, h),
            context=ctx,
            styles=styles,
            label=label,
            provided_texts=provided_texts,
            edit_mode=edit_mode,
        )
    except RuntimeError as e:
        progress.set_label(label)
        progress.error(f"translation error: {e}")
        raise HTTPException(status_code=502, detail=str(e))

    result_bubbles = [
        BubbleResult(
            bbox=BBox(
                x1=bt.bubble.x1,
                y1=bt.bubble.y1,
                x2=bt.bubble.x2,
                y2=bt.bubble.y2,
                conf=bt.bubble.conf,
            ),
            source_text=bt.text,
            translated_text=tr,
        )
        for bt, tr in zip(res.ocr, res.translations)
    ]
    return TranslateBoxesResponse(
        image_b64=_png_b64(res.result),
        clean_b64=_png_b64(res.clean) if res.clean is not None else None,
        mask_b64=_mask_overlay_b64(res.mask),
        bubbles=result_bubbles,
    )


@app.post("/clean/boxes", response_model=CleanBoxesResponse)
async def clean_boxes(
    file: UploadFile = File(...),
    boxes: str = Form(...),
    ocr_lang: Optional[str] = Form(default=None),
    lama_model: str = Form(default=""),
    mask_expand: Optional[float] = Form(default=None),
    mask_add: Optional[str] = Form(default=None),
    mask_erase: Optional[str] = Form(default=None),
    label: Optional[str] = Form(default=None),
):
    """GPU phase of "Translate all": OCR + inpaint for ready boxes, without LLM/render.

    Runs ahead in the queue while the LLM translates previous pages. Returns the inpainted
    page (clean_b64), mask, and OCR texts — the frontend passes them to the translation phase."""
    image = _read_image(await file.read())
    h, w = image.shape[:2]
    parsed = _parse_boxes(boxes, w, h)
    bubbles = [b for b, _ in parsed]
    default_expand = config.INPAINT_MASK_EXPAND if mask_expand is None else mask_expand
    default_ocr = ocr_lang or config.OCR_LANG
    mask_params = [_mask_params(m, default_expand) for _, m in parsed]
    ocr_langs = [m["ocr_lang"] or default_ocr for _, m in parsed]
    pad_fracs = [m["pad"] if m["pad"] is not None else 0.0 for _, m in parsed]
    progress.set_label(label)
    await _ensure_lama_ready(lama_model)
    progress.status(f"OCR: reading text ({len(bubbles)} bubbles)", log=False)
    _warmup(ocr_langs=ocr_langs or [default_ocr], lama_model=lama_model)
    await asyncio.sleep(0.25)

    res = await run_in_threadpool(
        clean_page,
        image,
        bubbles=bubbles,
        ocr_lang=ocr_lang,
        ocr_langs=ocr_langs,
        lama_model=lama_model,
        mask_expand=mask_expand,
        pad_fracs=pad_fracs,
        mask_params=mask_params,
        mask_add=_decode_mask_b64(mask_add, w, h),
        mask_erase=_decode_mask_b64(mask_erase, w, h),
        label=label,
    )
    result_bubbles = [
        BubbleSource(
            bbox=BBox(x1=bt.bubble.x1, y1=bt.bubble.y1, x2=bt.bubble.x2, y2=bt.bubble.y2,
                      conf=bt.bubble.conf),
            source_text=bt.text,
        )
        for bt in res.ocr
    ]
    return CleanBoxesResponse(
        clean_b64=_png_b64(res.clean if res.clean is not None else res.result),
        mask_b64=_mask_overlay_b64(res.mask),
        bubbles=result_bubbles,
    )


@app.post("/translate/render", response_model=TranslateRenderResponse)
async def translate_render_boxes(
    file: UploadFile = File(...),
    boxes: str = Form(...),
    ocr_lang: Optional[str] = Form(default=None),
    target_lang: Optional[str] = Form(default=None),
    context: Optional[str] = Form(default=None),
    label: Optional[str] = Form(default=None),
):
    """External pipeline phase: LLM + render on an already inpainted page.

    file — cleaned page (clean_b64 from /clean/boxes). Each box carries `text`
    (OCR source text from the clean phase) and render style. No inpaint is performed."""
    image = _read_image(await file.read())
    h, w = image.shape[:2]
    parsed = _parse_boxes(boxes, w, h)
    ctx = _parse_context(context)
    bubbles = [b for b, _ in parsed]
    source_texts = [m["text"] or "" for _, m in parsed]
    styles = [
        {"font": m["font"], "font_weight": m["font_weight"], "font_italic": m["font_italic"] or False,
         "font_size": m["font_size"], "margin": m["margin"],
         "align": m["align"], "valign": m["valign"], "slant": m["slant"],
         "vertical": m["vertical"], "color": m["color"],
         "stroke": m["stroke"], "stroke_width": m["stroke_width"], "stroke_color": m["stroke_color"]}
        for _, m in parsed
    ]
    progress.set_label(label)
    progress.status("translation: waiting for LLM response…", log=False)
    await asyncio.sleep(0.05)

    try:
        res = await run_in_threadpool(
            translate_render,
            image,
            bubbles,
            source_texts,
            source_lang=ocr_lang,
            target_lang=target_lang,
            context=ctx,
            styles=styles,
            label=label,
        )
    except RuntimeError as e:
        progress.set_label(label)
        progress.error(f"translation error: {e}")
        raise HTTPException(status_code=502, detail=str(e))

    result_bubbles = [
        BubbleResult(
            bbox=BBox(x1=b.x1, y1=b.y1, x2=b.x2, y2=b.y2, conf=b.conf),
            source_text=src,
            translated_text=tr,
        )
        for b, src, tr in zip(bubbles, source_texts, res.translations)
    ]
    return TranslateRenderResponse(image_b64=_png_b64(res.result), bubbles=result_bubbles)


@app.get("/fonts", response_model=FontsResponse)
def fonts() -> FontsResponse:
    """Font families with languages and weight/italic variant info."""
    from backend.pipeline.fonts import get_default_fonts
    from backend.pipeline.renderer import list_fonts

    return FontsResponse(
        fonts=[
            FontInfo(
                name=f["name"],
                langs=f["langs"],
                variants=f.get("variants", []),
                variant_langs=f.get("variant_langs", {}),
                weights=f.get("weights", []),
                has_italic=f.get("has_italic", False),
            )
            for f in list_fonts()
        ],
        defaults=get_default_fonts(),
    )


@app.get("/fonts/file/{name}")
def font_file(name: str, weight: Optional[str] = None, italic: int = 0):
    """Font file by family name + optional weight/italic — for @font-face preview in UI."""
    from fastapi.responses import FileResponse

    from backend.pipeline.renderer import _resolve_font

    path = _resolve_font(name, weight=weight, italic=bool(italic))
    if not path:
        raise HTTPException(status_code=404, detail="Font not found")
    return FileResponse(path, media_type="font/ttf")


@app.post("/render/boxes", response_model=RenderBoxesResponse)
async def render_boxes(
    file: UploadFile = File(...),
    boxes: str = Form(...),
    label: Optional[str] = Form(default=None),
):
    """Re-render translation on an already inpainted page — text only.

    file — page after inpaint (clean_b64 from /translate/boxes). boxes — JSON list
    [{x1,y1,x2,y2,text,font?,font_size?}] in original image pixels. No OCR/inpaint/LLM —
    fast redraw after manual text/font/size edits in the UI."""
    from backend.pipeline.renderer import get_renderer

    image = _read_image(await file.read())
    h, w = image.shape[:2]
    try:
        raw = json.loads(boxes)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON in boxes: {e}")
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="boxes must be a list of regions")

    items: List[tuple] = []
    for it in raw:
        try:
            x1 = max(0, min(w, int(it["x1"])))
            y1 = max(0, min(h, int(it["y1"])))
            x2 = max(0, min(w, int(it["x2"])))
            y2 = max(0, min(h, int(it["y2"])))
        except (KeyError, TypeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid region: {e}")
        if x2 <= x1 or y2 <= y1:
            continue
        try:
            style = {
                "font": it.get("font") or None,
                "font_weight": it.get("font_weight") or None,
                "font_italic": bool(it.get("font_italic")),
                "font_size": _opt(it, "font_size", int),
                "margin": _opt(it, "margin", float),
                "align": it.get("align") or None,
                "valign": it.get("valign") or None,
                "slant": _opt(it, "slant", float),
                "vertical": _opt(it, "vertical", bool),
                "color": it.get("color") or None,
                "stroke": _opt(it, "stroke", bool),
                "stroke_width": _opt(it, "stroke_width", int),
                "stroke_color": it.get("stroke_color") or None,
            }
        except (TypeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid font parameters: {e}")
        bubble = Bubble(x1=x1, y1=y1, x2=x2, y2=y2, conf=1.0)
        items.append((bubble, str(it.get("text") or ""), style))

    def _work():
        progress.set_label(label)
        try:
            progress.status("rendering translation")
            return get_renderer().render(image, items)
        finally:
            progress.clear()

    result = await run_in_threadpool(_work)
    return RenderBoxesResponse(image_b64=_png_b64(result))


@app.post("/mask/boxes", response_model=MaskPreviewResponse)
async def mask_boxes(
    file: UploadFile = File(...),
    boxes: str = Form(...),
    ocr_lang: Optional[str] = Form(default=None),
    mask_expand: Optional[float] = Form(default=None),
    label: Optional[str] = Form(default=None),
):
    """Fill mask preview for given regions: OCR + Otsu stroke mask, no inpaint.

    Computed right after detection/box edits so the user can see what will be erased
    before translating. boxes — JSON list of regions in original image pixels."""
    from backend.pipeline import cache
    from backend.pipeline.inpaint import build_text_mask
    from backend.pipeline.ocr import get_reader

    image = _read_image(await file.read())
    h, w = image.shape[:2]
    parsed = _parse_boxes(boxes, w, h)
    # only include bubbles that have mask preview enabled (default: yes)
    sel = [(b, m) for b, m in parsed if (m["show_mask"] if m["show_mask"] is not None else True)]
    if not sel:
        return MaskPreviewResponse(mask_b64=None)

    ocr_lang = ocr_lang or config.OCR_LANG
    default_expand = config.INPAINT_MASK_EXPAND if mask_expand is None else mask_expand
    bubbles = [b for b, _ in sel]
    params = [_mask_params(m, default_expand) for _, m in sel]
    ocr_langs = [m["ocr_lang"] or ocr_lang for _, m in sel]
    # Status on the event-loop, then yield so SSE flushes it BEFORE the pool grabs the GIL
    # for OCR — torch inference starves the loop, so per-bubble ticks wouldn't reach the bar
    # and it'd look idle. This persistent line stays visible for the whole read. Journal isn't
    # touched (preview is debounced and frequent); the real read is logged inside _work.
    progress.set_label(label)
    progress.status(f"OCR: reading text ({len(bubbles)} bubbles)", log=False)
    _warmup(ocr_langs=ocr_langs or [ocr_lang])
    await asyncio.sleep(0.25)

    def _work():
        progress.set_label(label)
        try:
            # OCR here is just a "has text?" gate for the mask, but it warms the OCR cache
            # the later Translate reuses. Log the read only when it actually ran (cache miss),
            # so the journal shows the first read and debounced previews don't spam it.
            h0 = cache.stats("ocr")[0]
            ocr_results = get_reader().read_bubbles_per_lang(image, bubbles, ocr_langs)
            if cache.stats("ocr")[0] - h0 < len(bubbles):
                found = sum(1 for b in ocr_results if b.text)
                progress.log(f"OCR: read {len(bubbles)} bubbles, text in {found}")
            return build_text_mask(image, ocr_results, params)
        finally:
            progress.clear()

    mask = await run_in_threadpool(_work)
    return MaskPreviewResponse(mask_b64=_mask_overlay_b64(mask))


@app.post("/detect")
async def detect(
    file: UploadFile = File(...),
    conf: float = Form(default=0.25),
):
    """Debug endpoint: page -> image with bboxes drawn."""
    from PIL import ImageDraw
    from backend.pipeline.detector import get_detector

    image = _read_image(await file.read())
    bubbles = get_detector().detect(image, conf=conf)
    img = Image.fromarray(image).convert("RGB")
    draw = ImageDraw.Draw(img)
    for b in bubbles:
        draw.rectangle([b.x1, b.y1, b.x2, b.y2], outline=(255, 0, 0), width=3)
        draw.text((b.x1, max(0, b.y1 - 12)), f"{b.conf:.2f}", fill=(255, 0, 0))
    return _png_response(np.array(img))


@app.post("/detect/json", response_model=DetectJSONResponse)
async def detect_json(
    file: UploadFile = File(...),
    conf: float = Form(default=0.25),
    label: Optional[str] = Form(default=None),
):
    """Detection only: page -> dimensions + bbox list (auto-detect on UI load)."""
    from backend.pipeline.detector import get_detector

    image = _read_image(await file.read())
    # set status immediately on the event loop (before warmup/pool) — otherwise the bar
    # only updates when the pool actually reaches _work (after model loading delay)
    progress.set_label(label)
    progress.status("bubble detection")
    _warmup(detector=True)

    def _work():
        progress.set_label(label)
        try:
            bubbles = get_detector().detect(image, conf=conf)
            progress.log(f"detection: found {len(bubbles)} bubbles")
            return bubbles
        finally:
            progress.clear()

    bubbles = await run_in_threadpool(_work)
    h, w = image.shape[:2]
    return DetectJSONResponse(
        width=w,
        height=h,
        bubbles=[
            BBox(x1=b.x1, y1=b.y1, x2=b.x2, y2=b.y2, conf=b.conf) for b in bubbles
        ],
    )


@app.post("/pdf/split", response_model=PdfSplitResponse)
async def pdf_split(file: UploadFile = File(...), scale: float = Form(default=2.0)):
    """PDF -> individual page images (base64 PNG) for the UI queue."""
    import pypdfium2 as pdfium

    data = await file.read()
    try:
        pdf = pdfium.PdfDocument(data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Failed to read PDF: {e}")

    pages: List[PdfPage] = []
    try:
        for i in range(len(pdf)):
            page = pdf[i]
            pil = page.render(scale=scale).to_pil().convert("RGB")
            arr = np.array(pil)
            h, w = arr.shape[:2]
            pages.append(
                PdfPage(index=i, width=w, height=h, image_b64=_png_b64(arr))
            )
    finally:
        pdf.close()
    return PdfSplitResponse(pages=pages)


# Serve the web UI (index.html at "/"). Mounted AFTER all API routes so they take priority.
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
