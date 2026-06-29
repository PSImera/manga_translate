"""Speech bubble detection: page -> list of bboxes.

Uses a trained YOLOv8 model (class location-of-bubbles).
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Union

import numpy as np

import config


@dataclass
class Bubble:
    """One detected speech bubble."""
    x1: int
    y1: int
    x2: int
    y2: int
    conf: float

    @property
    def xyxy(self) -> tuple[int, int, int, int]:
        return self.x1, self.y1, self.x2, self.y2

    @property
    def width(self) -> int:
        return self.x2 - self.x1

    @property
    def height(self) -> int:
        return self.y2 - self.y1


class BubbleDetector:
    """YOLOv8 wrapper. Model is loaded lazily on first use."""

    def __init__(self, weights: Optional[Union[str, Path]] = None, device: Optional[str] = None):
        self.weights = Path(weights) if weights else config.YOLO_WEIGHTS
        self.device = device  # None -> ultralytics picks automatically (GPU if available)
        self._model = None
        # Ultralytics predict() isn't thread-safe (shared predictor; first call fuses the
        # model in place). Batch upload fires parallel /detect/json in the pool, so serialize.
        self._lock = threading.Lock()

    @property
    def model(self):
        if self._model is None:
            if not self.weights.exists():
                self._download_weights()
            from ultralytics import YOLO
            self._model = YOLO(str(self.weights))
        return self._model

    def _download_weights(self) -> None:
        """Download weights from HuggingFace if not found locally."""
        from backend.pipeline import progress
        try:
            from huggingface_hub import hf_hub_download
            progress.status("Downloading detector weights from HuggingFace…")
            self.weights.parent.mkdir(parents=True, exist_ok=True)
            hf_hub_download(
                repo_id="PSImera/manga_bubbles_detect",
                filename=self.weights.name,
                local_dir=str(self.weights.parent),
            )
        except Exception as e:
            raise FileNotFoundError(
                f"YOLO weights not found: {self.weights}. "
                f"Auto-download from HuggingFace also failed: {e}"
            )

    def ensure(self) -> None:
        """Load YOLO weights. Call on the main thread before offloading to the pool."""
        _ = self.model

    def detect(
        self,
        image: np.ndarray,
        conf: float = 0.25,
        iou: float = 0.5,
        imgsz: int = 1024,
    ) -> List[Bubble]:
        """image — RGB HxWx3 array. Returns Bubble list sorted in reading order (top-to-bottom, then left-to-right)."""
        with self._lock:
            results = self.model.predict(
                source=image,
                conf=conf,
                iou=iou,
                imgsz=imgsz,
                device=self.device,
                verbose=False,
            )
        bubbles: List[Bubble] = []
        for r in results:
            if r.boxes is None:
                continue
            for box in r.boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                bubbles.append(
                    Bubble(
                        x1=int(round(x1)),
                        y1=int(round(y1)),
                        x2=int(round(x2)),
                        y2=int(round(y2)),
                        conf=float(box.conf[0]),
                    )
                )
        # Rough reading order: by row (y), then by x within the row.
        # For right-to-left manga the frontend re-sorts using its own strategy.
        bubbles.sort(key=lambda b: (b.y1, b.x1))
        return bubbles


_default_detector: Optional[BubbleDetector] = None


def get_detector() -> BubbleDetector:
    global _default_detector
    if _default_detector is None:
        _default_detector = BubbleDetector()
    return _default_detector
