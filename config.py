from __future__ import annotations

from pathlib import Path
from dotenv import load_dotenv
import os

ROOT_DIR = Path(__file__).resolve().parent

load_dotenv(ROOT_DIR / ".env")

# LLM
MODEL = os.getenv("MODEL", "gpt-5.5")
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "300"))
# How many previous pages to include in context during "Translate all" (0 = unlimited).
LLM_CONTEXT_PAGES = int(os.getenv("LLM_CONTEXT_PAGES", "8"))

# LLM provider. Explicit LLM_PROVIDER takes priority; otherwise the first provider
# with a key set is used, starting with openai (default path — local model in LM Studio/vLLM).
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "").strip().lower()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_API_BASE = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
XAI_API_KEY = os.getenv("XAI_API_KEY", "")
XAI_API_BASE = os.getenv("XAI_API_BASE", "https://api.x.ai/v1")


def resolve_llm() -> tuple[str, str, str]:
    """Returns (provider, api_key, api_base).

    grok/xai is OpenAI-compatible and reuses the openai client with its own base URL.
    """
    creds = {
        "openai": (OPENAI_API_KEY, OPENAI_API_BASE),
        "anthropic": (ANTHROPIC_API_KEY, ""),
        "google": (GOOGLE_API_KEY, ""),
        "grok": (XAI_API_KEY, XAI_API_BASE),
    }
    if LLM_PROVIDER:
        provider = "grok" if LLM_PROVIDER in ("grok", "xai") else LLM_PROVIDER
    elif ANTHROPIC_API_KEY and not OPENAI_API_KEY:
        provider = "anthropic"
    elif GOOGLE_API_KEY and not OPENAI_API_KEY:
        provider = "google"
    elif XAI_API_KEY and not OPENAI_API_KEY:
        provider = "grok"
    else:
        provider = "openai"
    key, base = creds.get(provider, (OPENAI_API_KEY, OPENAI_API_BASE))
    return provider, key, base


OCR_LANG = "ja"
TARGET_LANG = "ru"
OCR_DEVICE = os.getenv("OCR_DEVICE", "")

# Inpaint
INPAINT_MASK_EXPAND = 0.2
INPAINT_GROW = 3
INPAINT_INSET = 2
INPAINT_THICK_CAP = 0.33
INPAINT_MIN_AREA = 4
INPAINT_CENTER_PRIORITY = True
INPAINT_CENTER_RADIUS = 0.10

YOLO_WEIGHTS = Path(os.getenv("YOLO_WEIGHTS", "models/yolo/bubbles_detect_v1.pt"))
if not YOLO_WEIGHTS.is_absolute():
    YOLO_WEIGHTS = ROOT_DIR / YOLO_WEIGHTS

ASSETS_DIR = ROOT_DIR / "backend" / "assets"
FONTS_DIR = ASSETS_DIR / "fonts"

# LaMa inpaint models: name → {url, label}
# Models are cached in torch.hub dir (~/.cache/torch/hub/checkpoints/)
LAMA_MODEL_NAME = os.getenv("LAMA_MODEL_NAME", "big-lama")
LAMA_MODELS: dict[str, dict] = {
    "big-lama": {
        "url": "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt",
        "label": "big-lama",
    },
    "lama-manga": {
        "url": "https://huggingface.co/df1412/anime-big-lama/resolve/main/anime-manga-big-lama.pt",
        "label": "anime-big-lama",
    },
    "cv2": {"url": "", "label": "cv2 (fast)"},
}
