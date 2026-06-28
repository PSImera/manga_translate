"""In-process content-keyed caches for the pipeline.

Three independent layers, all keyed by content (not bubble index), so moving/adding
boxes doesn't needlessly invalidate:
- ocr:         (crop pixels, lang)        -> recognized text
- translation: (src lang, dst lang, text) -> translation
- inpaint:     (crop pixels, hole mask)   -> cleaned crop pixels

Bounded LRU per process; cleared via POST /cache/clear.
"""
from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict
from typing import Any, Optional, Tuple

# Per-thread hit/miss tallies. A whole page request runs in one threadpool worker,
# so these isolate cleanly per page and let the pipeline report "from cache" honestly.
_local = threading.local()


def _tally() -> dict:
    t = getattr(_local, "tally", None)
    if t is None:
        t = _local.tally = {}
    return t


def stats(name: str) -> Tuple[int, int]:
    """Cumulative (hits, misses) for cache `name` on the current worker thread.

    Cumulative, not per-call: snapshot before/after a phase and diff."""
    t = _tally()
    return t.get(name + ".hit", 0), t.get(name + ".miss", 0)


class LRUCache:
    def __init__(self, maxsize: int, name: str):
        self.maxsize = maxsize
        self.name = name
        self._d: "OrderedDict[str, Any]" = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Any]:
        t = _tally()
        with self._lock:
            hit = key in self._d
            if hit:
                self._d.move_to_end(key)
                value = self._d[key]
        suffix = ".hit" if hit else ".miss"
        t[self.name + suffix] = t.get(self.name + suffix, 0) + 1
        return value if hit else None

    def put(self, key: str, value: Any) -> None:
        with self._lock:
            self._d[key] = value
            self._d.move_to_end(key)
            while len(self._d) > self.maxsize:
                self._d.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._d.clear()

    def __len__(self) -> int:
        return len(self._d)


# Text entries are tiny; inpaint entries are RGB crops, so keep that pool small.
ocr_cache = LRUCache(8192, "ocr")
translation_cache = LRUCache(8192, "translation")
inpaint_cache = LRUCache(256, "inpaint")


def digest(*parts: bytes) -> str:
    h = hashlib.sha1()
    for p in parts:
        h.update(p)
        h.update(b"\x00")  # delimiter so concatenation is unambiguous
    return h.hexdigest()


def clear_all() -> dict:
    counts = {
        "ocr": len(ocr_cache),
        "translation": len(translation_cache),
        "inpaint": len(inpaint_cache),
    }
    ocr_cache.clear()
    translation_cache.clear()
    inpaint_cache.clear()
    return counts
