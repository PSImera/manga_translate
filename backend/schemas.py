"""Pydantic models for API requests and responses."""

from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, Field

OcrLang = str
TargetLang = str


class BBox(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int
    conf: float


class BubbleResult(BaseModel):
    bbox: BBox
    source_text: str
    translated_text: str


class TranslateJSONResponse(BaseModel):
    """Intermediate data response (no image — for debugging)."""

    width: int
    height: int
    ocr_lang: OcrLang
    target_lang: TargetLang
    bubbles: List[BubbleResult]


class DetectJSONResponse(BaseModel):
    """Detection only: page dimensions + found bboxes (for UI auto-detect)."""

    width: int
    height: int
    bubbles: List[BBox]


class BoxInput(BaseModel):
    """One manually defined region from the UI (coordinates in original image pixels)."""

    x1: int
    y1: int
    x2: int
    y2: int


class TranslateBoxesResponse(BaseModel):
    """Translation by ready region list: image (base64 PNG) + bubble texts."""

    image_b64: str
    clean_b64: Optional[str] = None  # page after inpaint
    mask_b64: Optional[str] = None  # fill mask
    bubbles: List[BubbleResult]


class BubbleSource(BaseModel):
    bbox: BBox
    source_text: str


class CleanBoxesResponse(BaseModel):
    """GPU pipeline phase: inpainted page + OCR texts, without translation."""

    clean_b64: str
    mask_b64: Optional[str] = None
    bubbles: List[BubbleSource]


class TranslateRenderResponse(BaseModel):
    """External pipeline phase: translation + render on already inpainted page."""

    image_b64: str
    bubbles: List[BubbleResult]


class RenderBoxesResponse(BaseModel):
    """Re-render text on an already inpainted page (after editing text/font in the UI)."""

    image_b64: str


class FontInfo(BaseModel):
    """Font family with supported languages and available weight/style variants."""

    name: str
    langs: List[str]
    variants: List[str] = []      # all variant names ("Regular", "Bold", "Bold Italic", ...)
    variant_langs: Dict[str, List[str]] = {}  # per-variant language coverage
    weights: List[str] = []       # distinct weights in display order
    has_italic: bool = False


class FontsResponse(BaseModel):
    """Available render fonts with supported languages (for UI list filtering)."""

    fonts: List[FontInfo]
    defaults: Dict[str, str] = {}  # {lang: font_name} — default font per language


class MaskPreviewResponse(BaseModel):
    """Fill mask preview for a given region list (no inpaint/translation).

    Computed right after detection/box edits so the user can see what will be erased
    before pressing Translate."""

    mask_b64: Optional[str] = None  # fill mask (red RGBA PNG), None if empty


class PdfPage(BaseModel):
    index: int
    width: int
    height: int
    image_b64: str


class PdfSplitResponse(BaseModel):
    """PDF split into individual page images."""

    pages: List[PdfPage]


class HealthResponse(BaseModel):
    status: str = "ok"
    model: str
    ocr_lang: str
    target_lang: str
    yolo_weights: str
    yolo_weights_exist: bool
    cuda: bool


class TranslateParams(BaseModel):
    ocr_lang: Optional[OcrLang] = Field(default=None, description="ja | en")
    target_lang: Optional[TargetLang] = Field(default=None, description="ru | en")
    conf: float = Field(default=0.25, ge=0.0, le=1.0)

