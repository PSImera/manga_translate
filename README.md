# Manga Translate

> [Русская версия](README-RU.md)

Neural-network manga translation pipeline: bubble detection → OCR → text removal (inpaint) → LLM translation → rendered output.

![Python](https://img.shields.io/badge/Python-3.10-blue?logo=python&logoColor=white)
![YOLOv8](https://img.shields.io/badge/YOLOv8-Ultralytics-purple)
![manga-ocr](https://img.shields.io/badge/manga--ocr-text-orange)
![LaMa](https://img.shields.io/badge/LaMa-inpaint-8A2BE2)
![LangChain](https://img.shields.io/badge/LangChain-LLM-1C3C3C?logo=langchain&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688?logo=fastapi&logoColor=white)
![Konva](https://img.shields.io/badge/Konva.js-frontend-0D83CD)
![uv](https://img.shields.io/badge/uv-package%20manager-DE5FE9?logo=uv&logoColor=white)

Everything runs **natively** (Python + torch, CUDA). The only external dependency is an LLM server (any OpenAI-compatible endpoint). No Docker needed for the app itself.

A learning project for [Deep Learning School](https://github.com/DeepLearningSchool).

---

![UI](images/UI.png)

## Features

### Quick start

The simplest workflow is two clicks: **upload pages** (images or PDF) and press **"Translate All"**. Bubble detection runs automatically after upload; translation streams through the queue — while the LLM translates one page, the next one is already being cleaned.

### Fine-grained control

Everything the auto-pipeline does can be overridden:

- **Bubble boxes** — add, move, resize, or delete boxes directly on the canvas. Detection confidence threshold is adjustable.
- **Reading order** — choose a strategy (rows LTR/RTL, columns) globally or per page; manually click bubbles in the desired order.
- **Inpaint mask** — a color preview shows exactly what will be erased before translation runs. Paint missed areas with a brush or erase false positives. The mask expansion slider fine-tunes the fill boundary.
- **Text detection settings** — stroke expansion, outward dilation, box inset, minimum blob area, center priority — globally and per bubble.
- **Font & style** — font family, absolute size (px), margin, alignment, slant, vertical (column) layout, text color, stroke — globally and per bubble.
- **Single-bubble translation** — select a box and click "Translate Bubble"; the rest of the page is untouched.
- **Text editing** — edit the translation directly in the side panel; "Apply" re-renders without OCR/inpaint/LLM.

### Languages

**OCR source:** Japanese (`manga-ocr`, manga-specialized), Simplified Chinese, Korean, English, Spanish, French, German, Portuguese, Italian, Polish, Hungarian, Swedish, Russian, Ukrainian, Hindi (via EasyOCR). Language is set globally per page and overridable per bubble (e.g. an English bubble inside a Japanese manga).

**Translation target:** Russian, English, Spanish, French, Portuguese, German, Ukrainian, Swedish, Italian, Polish, Hungarian, Japanese, Chinese, Korean, Hindi, Arabic, Hebrew. RTL languages (Arabic, Hebrew) render correctly (arabic-reshaper + python-bidi).

**Input formats:** JPEG, PNG, WebP, BMP, TIFF, PDF (split into pages automatically).

---

## Installation

### Requirements

- Python 3.10
- [uv](https://docs.astral.sh/uv/) — package manager.
- An external LLM server (see below).
- **GPU** (optional but strongly recommended):
  - **Windows / Linux** — NVIDIA GPU with CUDA 12.6+. `uv sync` pulls the CUDA torch build automatically.
  - **macOS Apple Silicon** — MPS acceleration is used automatically. `uv sync` pulls the standard PyPI torch build (no manual edits needed).
  - **CPU-only** — works on any platform, just slow.

### Steps

```bash
# 0. Install uv (if not already installed)
# Windows:
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
# macOS / Linux:
curl -LsSf https://astral.sh/uv/install.sh | sh

# 1. Clone the repository
git clone https://github.com/PSImera/manga_translate
cd manga_translate

# 2. Create environment and install dependencies
uv sync

# 3. Copy and fill in the config
cp .env.example .env
```

> manga-ocr, EasyOCR, LaMa and the bubble detector weights are downloaded automatically on first run.

---

## LLM setup

The app does **not** run an LLM itself — it needs an external server.

### Local model (LM Studio / Ollama / vLLM / any OpenAI-compatible server)

Any server with an OpenAI-compatible API works. [LM Studio](https://lmstudio.ai/) is the easiest option to get started.

Recommended model: `google/gemma-4-e4b` (or similar ~4B–8B).  
On 8 GB VRAM: ~15–20 s/page with reasoning; ~3 s/page without (lower quality). Quality depends heavily on the model — experiment freely.

Set the server address, key and model in `.env`:
```env
OPENAI_API_BASE=http://127.0.0.1:1234/v1
OPENAI_API_KEY=lmstudio
MODEL=google/gemma-4-e4b
```

### OpenAI API

```env
OPENAI_API_KEY=sk-...
MODEL=gpt-4o-mini
```

### Anthropic Claude

```bash
uv sync --extra anthropic
```
```env
ANTHROPIC_API_KEY=sk-ant-...
MODEL=claude-haiku-4-5-20251001
```

### Google Gemini

```bash
uv sync --extra google
```
```env
GOOGLE_API_KEY=...
MODEL=gemini-2.0-flash
```

### Grok (xAI)

```env
XAI_API_KEY=...
MODEL=grok-3-mini
```

The provider is auto-detected from whichever `*_API_KEY` is set (priority: `OPENAI_API_KEY`), or set explicitly via `LLM_PROVIDER=openai|anthropic|google|grok`.

---

## Configuration (`.env`)

```env
# LLM
MODEL=google/gemma-4-e4b
OPENAI_API_BASE=http://127.0.0.1:1234/v1
OPENAI_API_KEY=lmstudio

# Languages (defaults; overridable from UI)
OCR_LANG=ja           # ja → manga-ocr, otherwise EasyOCR
TARGET_LANG=ru

# OCR device
OCR_DEVICE=           # cpu | empty (= CUDA if available)

# Inpaint mask defaults (overridable from UI)
INPAINT_MASK_EXPAND=0.2
INPAINT_GROW=3
INPAINT_INSET=2
INPAINT_MIN_AREA=4
INPAINT_CENTER_PRIORITY=true
INPAINT_CENTER_RADIUS=0.10

# Detector weights (downloaded automatically on first run)
# YOLO_WEIGHTS=models/bubbles_detect/bubbles_detect.pt

# LLM context window for "Translate All" (last N pages; 0 = unlimited)
LLM_CONTEXT_PAGES=8
```

---

## Running

```powershell
.venv\Scripts\python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

On Windows you can also just double-click **`start.bat`** in the repo root.

Open **http://127.0.0.1:8000** — the web UI is served by the same process.

---

## Usage walkthrough

1. **Load pages** — click "＋ Load" or drag files. PDFs are split automatically. Bubble detection starts immediately after upload.
2. **Set languages** — source (OCR) and target (translation) in the toolbar.
3. **Click "Translate All"** — the pipeline processes all pages in the queue.
4. **Download** — "Download" saves the current page; after translating all pages a ZIP or PDF is offered.

The **"⬚ Boxes"** toggle expands bubble box tools. **"🖌 Mask"** expands the inpaint mask preview and brush tools. Both collapse and hide their canvas overlays when closed.

**Left panel** (`‹`) — per-bubble settings for the selected box.  
**Right panel** (`›`) — original and translated text for each bubble, editable with style controls.

---

## How it works

```
Image / PDF
   ↓
Bubble detection   YOLOv8 (custom trained model, valid mAP50 ≈ 0.977)
   ↓
OCR                manga-ocr (Japanese) | EasyOCR (other languages)
   ↓
Inpaint            Otsu stroke mask + LaMa on per-bubble crops
   ↓
Translation        external LLM (whole page in one request, JSON response)
   ↓
Render             Pillow — text fitted into bubble bbox
```

**LLM context:** when translating a full manga, each page receives the translated text of previous pages (last `LLM_CONTEXT_PAGES` pages) so the model maintains character names, tone, and plot continuity.

**Memory:** VRAM stays within budget — LaMa runs on small per-bubble crops, not the full page.

**Stack:** YOLOv8 · manga-ocr · EasyOCR · LaMa · LangChain · FastAPI · Konva.js · Pillow · pypdfium2 · uv

---

## Fonts

Place `.ttf`/`.otf` files in `backend/assets/fonts/`. A single file = a font family; a subfolder with files = family with variants (Regular/Bold/…). Supported languages are detected automatically from the cmap; the cache in `backend/assets/font_languages.json` is updated when the file set changes. Force rebuild:

```powershell
.venv\Scripts\python -m backend.pipeline.fonts
```

---

## Training data

The detector was trained on a combined dataset:

- [manga.v4i (Roboflow)](https://universe.roboflow.com/manga-wtdm0/manga-mvbxx) — 1304/189/103 train/valid/test pages, single class `location-of-bubbles`.
- [1079 additional pages](https://drive.google.com/drive/folders/198OVEXLxY9hyhC0bdALxtR66BtBHp_Oj?usp=sharing) from [DLS Manga Translator](https://github.com/ikefir34/DLS_Manga_Translator) — pre-labeled with v1 (trained on the first dataset) → manually corrected in CVAT → merged → fine-tuned as v2.

Training scripts are in `training/` and are not needed to run the app.

The combined dataset is published on HuggingFace: [PSImera/manga_bubbles_detect](https://huggingface.co/datasets/PSImera/manga_bubbles_detect).

The trained model weights are published on HuggingFace: [PSImera/manga_bubbles_detect](https://huggingface.co/PSImera/manga_bubbles_detect) — downloaded automatically on first run.
