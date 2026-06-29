---
license: mit
tags:
  - object-detection
  - manga
  - yolov8
  - speech-bubble-detection
  - ultralytics
datasets:
  - PSImera/manga_bubbles_detect
---

# manga_bubbles_detect

YOLOv8 model for detecting speech bubbles in manga pages. Trained to locate bubble bounding boxes (single class `location-of-bubbles`).

**Validation mAP50 ≈ 0.977**

Part of [Manga Translate](https://github.com/PSImera/manga_translate) — a full manga translation pipeline (bubble detection → OCR → inpaint → LLM → render).

![preview](preview.png)

## Usage

```python
from ultralytics import YOLO

model = YOLO("bubbles_detect.pt")
results = model.predict("page.jpg", conf=0.25, iou=0.5, imgsz=1024)
```

Or use it automatically via the [Manga Translate](https://github.com/PSImera/manga_translate) app — the model is downloaded from here on first run.

## Training data

Trained on a combined dataset published at [PSImera/manga_bubbles_detect](https://huggingface.co/datasets/PSImera/manga_bubbles_detect):

- [manga.v4i (Roboflow)](https://universe.roboflow.com/manga-wtdm0/manga-mvbxx) — 1304/189/103 train/valid/test pages
- 1079 additional pages from [DLS Manga Translator](https://github.com/ikefir34/DLS_Manga_Translator), manually corrected in CVAT

Training scripts and reports: [training/](https://github.com/PSImera/manga_translate/tree/main/training)
