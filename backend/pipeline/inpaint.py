"""
Original text removal (inpaint).
Primary engine: simple-lama-inpainting.
Fast fallback: cv2.inpaint.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Union

import cv2
import numpy as np

from backend.pipeline import cache, progress
from backend.pipeline.detector import Bubble
from backend.pipeline.ocr import BubbleText


@dataclass
class MaskParams:
    """Stroke mask detection parameters for one bubble (see build_text_mask).

    All exposed in the UI (global default + per-bubble override):
    expand — expand around strokes by a fraction of STROKE THICKNESS (0..1);
    grow — additional uniform outward dilation of the final mask, in pixels (on top of expand);
    inset — inward offset from the bbox before searching (avoids touching the bubble outline), px;
    thick_cap — 'thick stroke' threshold as a fraction of min(bw,bh): thicker components are
                discarded as artwork/fill (higher → keeps bold/solid strokes and vertical dashes);
    min_area — components smaller than this (px²) are treated as noise;
    center_priority — whether to discard components mostly near the bbox edge (bubble outline);
    center_radius — fraction of the inward margin for the 'central zone' (smaller → stricter edge rejection)."""

    expand: float = 0.2
    grow: int = 3
    inset: int = 2
    thick_cap: float = 0.33
    min_area: int = 4
    center_priority: bool = True
    center_radius: float = 0.10


def _fill_holes(binmask: np.ndarray) -> np.ndarray:
    """Fill all enclosed holes inside connected contours."""
    h, w = binmask.shape[:2]
    padded = cv2.copyMakeBorder(binmask, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    ff_mask = np.zeros((h + 4, w + 4), dtype=np.uint8)
    flood = padded.copy()
    cv2.floodFill(flood, ff_mask, (0, 0), 255)
    holes = cv2.bitwise_not(flood)[1:-1, 1:-1]
    return cv2.bitwise_or(binmask, holes)


def _which_box(cx: float, cy: float, boxes: List[tuple], contained_only: bool = False):
    """Index of the box that owns the blob with centroid (cx, cy).

    Returns the box containing the centroid. If none contains it:
    contained_only=True → None (blob is outside all boxes, e.g. manual brush — handled separately),
    otherwise → nearest box by center distance."""
    best, bestd = 0, None
    for bi, (x1, y1, x2, y2) in enumerate(boxes):
        if x1 <= cx <= x2 and y1 <= cy <= y2:
            return bi
        mx, my = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        d = (cx - mx) ** 2 + (cy - my) ** 2
        if bestd is None or d < bestd:
            best, bestd = bi, d
    return None if contained_only else best


def build_text_mask(
    image: np.ndarray,
    bubble_texts: List[BubbleText],
    params: Union[MaskParams, List[MaskParams], None] = None,
) -> np.ndarray:
    """Binary mask (uint8 0/255): white = pixels to erase.

    manga-ocr gives no per-line coordinates, so text strokes are detected inside each
    bubble using Otsu thresholding.

    The bubble bbox is the SEARCH REGION only. Otsu gives stroke candidates; connected
    components then keep only stroke-shaped ones (letters) and discard thick solid blobs
    (artwork/fill) — otherwise a painted background would be erased entirely.
    'Thick' is measured relative to the BOX SIZE (not the median of components) so that
    bold kanji next to thin furigana aren't wrongly flagged as anomalously thick.

    Center priority: text is expected in the center of the bubble; the outline is at the edge.
    """
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    mask = np.zeros((h, w), dtype=np.uint8)
    default_params = MaskParams() if params is None or isinstance(params, list) else params

    total = len(bubble_texts)
    for idx, bt in enumerate(bubble_texts):
        if not bt.text:
            continue
        progress.status(f"text mask: bubble {idx + 1}/{total}", log=False)
        p = params[idx] if isinstance(params, list) else default_params
        bexpand = max(0.0, min(1.0, p.expand))
        b = bt.bubble
        # search inside the bubble with a small inset so we don't clip the bubble outline
        dx1, dy1 = max(0, b.x1 + p.inset), max(0, b.y1 + p.inset)
        dx2, dy2 = min(w, b.x2 - p.inset), min(h, b.y2 - p.inset)
        if dx2 <= dx1 or dy2 <= dy1:
            continue

        sub = gray[dy1:dy2, dx1:dx2]
        bh, bw = sub.shape[:2]
        # Otsu splits background/text. Polarity by mean: light bubble → dark text.
        _thr, binim = cv2.threshold(sub, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        cand = ((binim == 0) if sub.mean() >= 127 else (binim == 255)).astype(np.uint8)
        if not cand.any():
            continue

        num, labels, stats, _ = cv2.connectedComponentsWithStats(cand, connectivity=8)
        comps = []  # (label, cw, ch, area, thickness)
        for i in range(1, num):
            cx, cy, cw, ch, area = stats[i]
            if area < p.min_area:  # noise
                continue
            cm = (labels[cy:cy + ch, cx:cx + cw] == i).astype(np.uint8)
            # 1-pixel background border: a solid rectangular component (e.g. a vertical dash
            # that fully fills its bbox) has no interior background, so distanceTransform
            # returns garbage (~1e38) and the stroke is falsely flagged as 'thick' and dropped.
            cm = cv2.copyMakeBorder(cm, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
            d = cv2.distanceTransform(cm, cv2.DIST_L2, 3)
            dv = d[d > 0]
            thick = float(dv.max()) * 2.0 if dv.size else 1.0
            comps.append((i, cw, ch, area, thick))
        if not comps:
            continue

        # 'thick' threshold relative to BOX SIZE, not component median: bold kanji next to
        # thin furigana would look N× thicker than neighbors and be wrongly discarded.
        thick_cap = p.thick_cap * min(bw, bh)

        # center priority: text sits in the middle of the bubble; outline is at the edge.
        # central zone = bbox shrunk by margin; we check what fraction of each component falls inside.
        inner_counts = None
        if p.center_priority:
            margin = max(2, int(round(min(bw, bh) * p.center_radius)))
            inner = np.zeros((bh, bw), dtype=bool)
            if bh > 2 * margin and bw > 2 * margin:
                inner[margin:bh - margin, margin:bw - margin] = True
            inner_counts = (
                np.bincount(labels[inner].ravel(), minlength=num)
                if inner.any() else None
            )

        keep = []
        for (i, cw, ch, area, thick) in comps:
            if thick > thick_cap:                    # too thick → artwork/fill
                continue
            if cw >= 0.95 * bw and ch >= 0.95 * bh:  # spans the whole box → background/outline
                continue
            # mostly at the edge (few center pixels) → bubble outline
            if inner_counts is not None and inner_counts[i] < 0.5 * area:
                continue
            keep.append(i)
        if not keep:
            continue

        text = np.isin(labels, keep).astype(np.uint8) * 255
        # robust stroke thickness from selected strokes only (percentile, not outlier-sensitive max)
        d = cv2.distanceTransform(text, cv2.DIST_L2, 3)
        dv = d[d > 0]
        stroke = max(1.0, 2.0 * float(np.percentile(dv, 80))) if dv.size else 1.0

        # close small gaps inside letters so each character is covered fully
        ck = max(1, int(round(stroke * 0.5)))
        text = cv2.morphologyEx(
            text, cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * ck + 1, 2 * ck + 1)),
        )
        # fill holes inside outlines so the mask is solid blobs without gaps
        text = _fill_holes(text)
        # expand around strokes by a fraction of their thickness + additional uniform grow
        grow = max(0, int(round(p.grow)))
        r = max(1, int(round(stroke * (0.5 + bexpand)))) + grow

        # working area = detection region + r on all sides, clipped to image bounds
        rx1, ry1 = max(0, dx1 - r), max(0, dy1 - r)
        rx2, ry2 = min(w, dx2 + r), min(h, dy2 + r)
        canvas = np.zeros((ry2 - ry1, rx2 - rx1), dtype=np.uint8)
        canvas[dy1 - ry1:dy1 - ry1 + bh, dx1 - rx1:dx1 - rx1 + bw] = text

        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
        canvas = cv2.dilate(canvas, k, iterations=1)

        np.maximum(mask[ry1:ry2, rx1:rx2], canvas, out=mask[ry1:ry2, rx1:rx2])

    return mask


def _lama_cache_path(url: str) -> str:
    """Path in the torch.hub cache for the given URL (same location as SimpleLama uses)."""
    from simple_lama_inpainting.utils.util import get_cache_path_by_url
    return get_cache_path_by_url(url)


def download_lama_model(model_name: str) -> Optional[str]:
    """Download a LaMa model to the torch.hub cache if not already present. Returns path or None."""
    import config
    from simple_lama_inpainting.utils.util import download_model
    info = config.LAMA_MODELS.get(model_name)
    if not info or not info.get("url"):
        return None
    return download_model(info["url"])


class InpaintEngine:
    """LaMa with cv2.inpaint fallback. use_lama is determined by model_name."""

    def __init__(self, model_name: str = "big-lama", device: Optional[str] = None):
        self.model_name = model_name
        self.use_lama = model_name != "cv2"
        self.device = device
        self._lama = None

    def ensure(self) -> None:
        """Load LaMa if needed. Call on the main thread before offloading to the pool."""
        if self.use_lama:
            self._ensure_lama()

    def _ensure_lama(self):
        if self._lama is None:
            import os
            import config
            from simple_lama_inpainting import SimpleLama
            from simple_lama_inpainting.utils.util import download_model
            info = config.LAMA_MODELS.get(self.model_name, {})
            url = info.get("url", "")
            if url:
                # download to the standard torch.hub cache, then point SimpleLama to it via env var
                path = download_model(url)
                old = os.environ.get("LAMA_MODEL")
                os.environ["LAMA_MODEL"] = path
                try:
                    self._lama = SimpleLama(device=self.device) if self.device else SimpleLama()
                finally:
                    if old is None:
                        os.environ.pop("LAMA_MODEL", None)
                    else:
                        os.environ["LAMA_MODEL"] = old
            else:
                self._lama = SimpleLama(device=self.device) if self.device else SimpleLama()
        return self._lama

    def inpaint(
        self,
        image: np.ndarray,
        mask: np.ndarray,
        bubble_boxes: Optional[List[tuple]] = None,
        pad_fracs: Optional[List[float]] = None,
    ) -> np.ndarray:
        """image — RGB HxWx3, mask — uint8 0/255 (white = erase).
        Returns RGB page with text removed.

        bubble_boxes — (x1,y1,x2,y2) of boxes: blobs are grouped by box, and LaMa operates
        on the WHOLE BUBBLE crop (not individual blobs); status is reported per bubble.
        pad_fracs — context around the box as a FRACTION of its size (aligned with bubble_boxes):
        0 = crop exactly at the bubble edge, 0.2 = +10% on each side."""
        if not mask.any():
            return image.copy()

        if self.use_lama:
            try:
                return self._inpaint_lama(image, mask, bubble_boxes, pad_fracs)
            except Exception as e:  # noqa: BLE001
                print(f"[inpaint] LaMa unavailable ({e}); falling back to cv2.inpaint")

        return self._inpaint_cv2(image, mask)

    def _inpaint_lama(
        self,
        image: np.ndarray,
        mask: np.ndarray,
        bubble_boxes: Optional[List[tuple]] = None,
        pad_fracs: Optional[List[float]] = None,
        orphan_pad: int = 32,
    ) -> np.ndarray:
        from PIL import Image

        lama = self._ensure_lama()
        h, w = image.shape[:2]
        bin_mask = (mask > 127).astype(np.uint8)
        num, labels, stats, centroids = cv2.connectedComponentsWithStats(bin_mask, connectivity=8)
        if num <= 1:  # background only
            return image.copy()
        out = image.copy()

        def _do(box: tuple, ids: list) -> None:
            """Inpaint one crop box=(bx1,by1,bx2,by2) (already padded and clipped).

            The hole for LaMa is ALL text in the crop (including text from overlapping neighbor
            boxes) so the engine doesn't copy a neighbor's text pattern as background.
            Only OWN pixels (blobs in ids) are pasted back — each neighbor box gets its own pass."""
            x1 = max(0, int(round(box[0])))
            y1 = max(0, int(round(box[1])))
            x2 = min(w, int(round(box[2])))
            y2 = min(h, int(round(box[3])))
            if x2 <= x1 or y2 <= y1:
                return
            crop = image[y1:y2, x1:x2]
            hole = bin_mask[y1:y2, x1:x2] * 255       # all text in crop → kept out of LaMa context
            if not hole.any():
                return
            # cache by crop pixels + hole: editing text/font reuses the fill; moving the
            # box or changing the mask changes the bytes -> miss -> re-inpaint (as needed).
            ckey = cache.digest(
                repr(crop.shape).encode(),
                np.ascontiguousarray(crop).tobytes(),
                np.ascontiguousarray(hole).tobytes(),
            )
            res = cache.inpaint_cache.get(ckey)
            if res is None:
                res = lama(
                    Image.fromarray(crop).convert("RGB"),
                    Image.fromarray(hole).convert("L"),
                )
                res = np.asarray(res.convert("RGB").resize((x2 - x1, y2 - y1)))
                cache.inpaint_cache.put(ckey, res)
            own = np.isin(labels[y1:y2, x1:x2], ids)  # paste back only this box's blobs
            out[y1:y2, x1:x2][own] = res[own]

        comps = list(range(1, num))  # 0 = background
        if bubble_boxes:
            # assign blobs to boxes by centroid; crop is the whole bubble; status per bubble.
            # Blobs outside all boxes (e.g. manual brush) are each processed by their own bbox.
            groups: dict = {}
            orphans: list = []
            for i in comps:
                bi = _which_box(centroids[i][0], centroids[i][1], bubble_boxes, contained_only=True)
                if bi is None:
                    orphans.append(i)
                else:
                    groups.setdefault(bi, []).append(i)
            ordered = sorted(groups)
            total = len(ordered) + len(orphans)
            step = 0
            for bi in ordered:
                step += 1
                progress.status(f"inpaint: bubble {step}/{total}", log=False)
                ids = groups[bi]
                bx1, by1, bx2, by2 = bubble_boxes[bi]
                # context = fraction of BUBBLE SIZE (same as the dashed border in UI)
                frac = pad_fracs[bi] if pad_fracs is not None else 0.0
                rx = frac / 2.0 * (bx2 - bx1)
                ry = frac / 2.0 * (by2 - by1)
                cx1, cy1, cx2, cy2 = bx1 - rx, by1 - ry, bx2 + rx, by2 + ry
                for i in ids:  # don't clip strokes that grew past the box edge: union with blob bboxes
                    x, y, bw, bh, _a = stats[i]
                    cx1, cy1 = min(cx1, x), min(cy1, y)
                    cx2, cy2 = max(cx2, x + bw), max(cy2, y + bh)
                _do((cx1, cy1, cx2, cy2), ids)
            for i in orphans:
                step += 1
                progress.status(f"inpaint: manual mask {step}/{total}", log=False)
                x, y, bw, bh, _a = stats[i]
                _do((x - orphan_pad, y - orphan_pad, x + bw + orphan_pad, y + bh + orphan_pad), [i])
        else:
            # no boxes — fallback: process each blob by its own bbox
            for n, i in enumerate(comps, 1):
                progress.status(f"inpaint LaMa: region {n}/{num - 1}", log=False)
                x, y, bw, bh, _a = stats[i]
                _do((x - orphan_pad, y - orphan_pad, x + bw + orphan_pad, y + bh + orphan_pad), [i])

        return out

    def _inpaint_cv2(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        bgr = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        out = cv2.inpaint(bgr, (mask > 127).astype(np.uint8) * 255, 3, cv2.INPAINT_TELEA)
        return cv2.cvtColor(out, cv2.COLOR_BGR2RGB)


_engines: dict[str, InpaintEngine] = {}


def get_engine(model_name: str = "big-lama") -> InpaintEngine:
    if model_name not in _engines:
        _engines[model_name] = InpaintEngine(model_name=model_name)
    return _engines[model_name]
