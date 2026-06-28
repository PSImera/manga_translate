"""Pipeline progress broker: current activity + event log.

Pipeline stages (detection/OCR/mask/inpaint/translation/render) write a short status here
(for the UI header bar) and log lines (for the console). The backend streams this via SSE
(`/events`); the frontend shows live status and a detailed log.

Heavy work (torch) runs in the thread pool while SSE runs on the event loop — so status
reaches the UI during processing. The current page label is stored in thread-local storage:
each stage sets it once (`set_label`), and nested OCR/mask/inpaint functions just call
`status(...)` and the label is appended automatically.
"""
from __future__ import annotations

import itertools
import threading
import time
from collections import deque
from typing import List, Optional

_lock = threading.Lock()
_seq = itertools.count(1)
_log: deque = deque(maxlen=500)     # [{seq, ts, level, msg}]
_bar = {"text": "", "rev": 0}       # current (transient) status for the bar
_ctx = threading.local()            # current page label, per worker thread


def set_label(label: Optional[str]) -> None:
    """Store the current page label for subsequent status()/log() calls on this thread."""
    _ctx.label = (label or "").strip()


def _label() -> str:
    return getattr(_ctx, "label", "")


def _decorate(msg: str) -> str:
    lbl = _label()
    return f"{msg} · {lbl}" if lbl else msg


def status(msg: str, *, log: bool = True, level: str = "info") -> None:
    """Set the current bar status. Also writes to the log by default.

    For frequent per-bubble ticks (mask preview) pass log=False — updates the bar
    without cluttering the log."""
    text = _decorate(msg)
    with _lock:
        _bar["text"] = text
        _bar["rev"] += 1
        if log:
            _log.append({"seq": next(_seq), "ts": time.time(), "level": level, "msg": text})


def log(msg: str, *, level: str = "info") -> None:
    """Append a line to the log only (bar is not updated)."""
    text = _decorate(msg)
    with _lock:
        _log.append({"seq": next(_seq), "ts": time.time(), "level": level, "msg": text})


def error(msg: str) -> None:
    """Write an error to the log and clear the bar (process was interrupted)."""
    text = _decorate(msg)
    with _lock:
        _bar["text"] = ""
        _bar["rev"] += 1
        _log.append({"seq": next(_seq), "ts": time.time(), "level": "error", "msg": text})


def clear() -> None:
    """Clear the bar (process finished — don't leave the last stage status visible)."""
    with _lock:
        if _bar["text"]:
            _bar["text"] = ""
            _bar["rev"] += 1
    set_label(None)


def snapshot(after: int = 0) -> dict:
    """Current bar state + new log entries with seq > after."""
    with _lock:
        new: List[dict] = [e for e in _log if e["seq"] > after]
        last = _log[-1]["seq"] if _log else 0
        return {"bar": _bar["text"], "rev": _bar["rev"], "log": new, "last": last}
