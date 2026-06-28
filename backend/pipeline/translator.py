"""Bubble text translation via LLM (LangChain + OpenAI wrapper → LM Studio / vLLM).

All bubbles on a page are translated in one request so the model sees dialogue context
and maintains consistent tone. Response is expected strictly as JSON.
"""
from __future__ import annotations

import json
from typing import List, Optional

import config
from backend.pipeline import cache

# English language names for the LLM prompt — model must receive "Hindi", not the code "hi"
# (otherwise it tends to fall back to English).
_LANG_NAMES = {
    "ja": "Japanese",
    "en": "English",
    "ru": "Russian",
    "fr": "French",
    "pt": "Portuguese",
    "de": "German",
    "uk": "Ukrainian",
    "sv": "Swedish",
    "it": "Italian",
    "pl": "Polish",
    "hu": "Hungarian",
    "es": "Spanish",
    "zh": "Chinese (Simplified)",
    "ko": "Korean",
    "hi": "Hindi",
    "ar": "Arabic",
    "he": "Hebrew",
}


SYSTEM_PROMPT = (
    "You are a professional manga translator. You translate dialogue from speech bubbles.\n"
    "Rules:\n"
    "- Maintain the meaning, tone, and emotion of the original (shouts, whispers, onomatopoeia).\n"
    "- The translation should sound natural and conversational in the target language.\n"
    "- Do not add explanations, notes, or quotation marks.\n"
    "- Keep the order of dialogue exactly as in the input.\n"
    "- Respond ONLY with valid JSON, without Markdown wrappers."
)

# Edit mode: user re-translates a single reply inside a manga that is already translated.
# The history shown is the established translation — match its names/tone/terms.
SYSTEM_PROMPT_EDIT = (
    "You are a professional manga translator. You are RE-TRANSLATING a reply inside a manga "
    "that is already translated. The dialogue shown before the request is the established "
    "translation — keep names, terminology, tone, and style consistent with it.\n"
    "Rules:\n"
    "- Maintain the meaning, tone, and emotion of the original (shouts, whispers, onomatopoeia).\n"
    "- The translation should sound natural and conversational in the target language.\n"
    "- Do not add explanations, notes, or quotation marks.\n"
    "- Keep the order of dialogue exactly as in the input.\n"
    "- Respond ONLY with valid JSON, without Markdown wrappers."
)

# langchain module and pip package (extra for `uv sync --extra ...`) per provider.
# openai/grok go through langchain-openai (grok is OpenAI-compatible).
_PROVIDER_PKG = {
    "anthropic": ("langchain_anthropic", "ChatAnthropic", "anthropic"),
    "google": ("langchain_google_genai", "ChatGoogleGenerativeAI", "google"),
}


def _import_chat(module: str, cls: str, extra: str):
    try:
        mod = __import__(module, fromlist=[cls])
    except ImportError as e:
        raise RuntimeError(
            f"Provider requires package {module.replace('_', '-')}. "
            f"Install it: uv sync --extra {extra}"
        ) from e
    return getattr(mod, cls)


class Translator:
    def __init__(
        self,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        api_base: Optional[str] = None,
        api_key: Optional[str] = None,
        temperature: float = 0.3,
    ):
        rp, rkey, rbase = config.resolve_llm()
        self.provider = provider or rp
        self.model = model or config.MODEL
        self.api_base = api_base or rbase
        self.api_key = api_key or rkey
        self.temperature = temperature
        self.timeout = config.LLM_TIMEOUT
        self._llm = None

    @property
    def llm(self):
        if self._llm is None:
            self._llm = self._make_llm()
        return self._llm

    def _make_llm(self):
        common = dict(model=self.model, temperature=self.temperature, max_retries=1)
        if self.provider == "anthropic":
            ChatAnthropic = _import_chat(*_PROVIDER_PKG["anthropic"])
            return ChatAnthropic(api_key=self.api_key, timeout=self.timeout, **common)
        if self.provider == "google":
            ChatGoogleGenerativeAI = _import_chat(*_PROVIDER_PKG["google"])
            return ChatGoogleGenerativeAI(
                google_api_key=self.api_key, timeout=self.timeout, **common
            )
        # openai / grok / local model — all via the OpenAI-compatible client
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            base_url=self.api_base, api_key=self.api_key, timeout=self.timeout, **common
        )

    def translate_texts(
        self,
        texts: List[str],
        source_lang: Optional[str] = None,
        target_lang: Optional[str] = None,
        context: Optional[List[List[dict]]] = None,
        edit_mode: bool = False,
    ) -> List[str]:
        """Translate all dialogue lines from one page.

        context — lines from already-translated previous pages (for "Translate all"):
        list of pages, each a list of {"source": ..., "translated": ...}. Injected as
        past dialogue turns so the model sees plot/names/tone from the whole manga.
        None for single-page translation.

        edit_mode — re-translating a single bubble in an already-translated manga
        ("Translate bubble" button): uses a different system prompt and bypasses the cache
        (otherwise the same text would be returned unchanged).
        """
        source_lang = source_lang or config.OCR_LANG
        target_lang = target_lang or config.TARGET_LANG

        idx_nonempty = [i for i, t in enumerate(texts) if t and t.strip()]
        if not idx_nonempty:
            return list(texts)

        src = _LANG_NAMES.get(source_lang, source_lang)
        dst = _LANG_NAMES.get(target_lang, target_lang)
        clean = {i: texts[i].replace("\n", " ").strip() for i in idx_nonempty}

        # cache by source text (+langs): unchanged lines aren't re-sent to the LLM,
        # so moving a box or re-translating a page only pays for what actually changed.
        # Keyed on text alone (not page context) for stable, consistent translations.
        tkey = {i: cache.digest(src.encode(), dst.encode(), clean[i].encode()) for i in idx_nonempty}
        translations = list(texts)
        pending = []
        for i in idx_nonempty:
            # edit mode forces a fresh LLM call (cache is keyed on text alone, so a hit
            # would just echo the previous translation back)
            hit = None if edit_mode else cache.translation_cache.get(tkey[i])
            if hit is not None:
                translations[i] = hit
            else:
                pending.append(i)
        if not pending:
            return translations

        history = self._build_history(context, src, dst)
        system = SYSTEM_PROMPT_EDIT if edit_mode else SYSTEM_PROMPT

        # retry for missing ids
        for _attempt in range(2):
            if not pending:
                break
            parsed = self._invoke([{"id": i, "text": clean[i]} for i in pending], src, dst, history, system)
            by_id = {
                item["id"]: (item.get("text") or "").strip()
                for item in parsed
                if isinstance(item.get("id"), int)
            }
            for i in list(pending):
                txt = by_id.get(i)
                if txt:
                    translations[i] = txt
                    cache.translation_cache.put(tkey[i], txt)
                    pending.remove(i)

        # per-bubble fallback for still-missing ids: batch of one line,
        # accept the single answer even if the id doesn't match
        for i in pending:
            try:
                parsed = self._invoke([{"id": i, "text": clean[i]}], src, dst, history, system)
            except RuntimeError:
                continue
            txt = ""
            if len(parsed) == 1:
                txt = (parsed[0].get("text") or "").strip()
            else:
                for item in parsed:
                    if item.get("id") == i:
                        txt = (item.get("text") or "").strip()
                        break
            if txt:
                translations[i] = txt
                cache.translation_cache.put(tkey[i], txt)

        return translations

    @staticmethod
    def _user_prompt(payload: List[dict], src: str, dst: str) -> str:
        return (
            f"Translate replies from {src} to {dst}.\n"
            f"Return JSON of the form {{\"translations\": [{{\"id\": <id>, \"text\": <translation>}}]}} "
            f"with the same set of ids.\n\n"
            f"Replies:\n{json.dumps(payload, ensure_ascii=False)}"
        )

    def _build_history(
        self, context: Optional[List[List[dict]]], src: str, dst: str
    ) -> List[tuple]:
        """Reconstruct previous pages as dialogue turns (human request → ai reply)."""
        if not context:
            return []
        pages = context[-config.LLM_CONTEXT_PAGES:] if config.LLM_CONTEXT_PAGES > 0 else context
        history: List[tuple] = []
        for page in pages:
            pairs = [
                (str(p.get("source") or "").replace("\n", " ").strip(),
                 str(p.get("translated") or "").strip())
                for p in (page or [])
            ]
            pairs = [(s, t) for s, t in pairs if s and t]
            if not pairs:
                continue
            payload = [{"id": i, "text": s} for i, (s, _) in enumerate(pairs)]
            answer = {"translations": [{"id": i, "text": t} for i, (_, t) in enumerate(pairs)]}
            history.append(("human", self._user_prompt(payload, src, dst)))
            history.append(("ai", json.dumps(answer, ensure_ascii=False)))
        return history

    def _invoke(
        self, payload: List[dict], src: str, dst: str,
        history: Optional[List[tuple]] = None, system: str = SYSTEM_PROMPT,
    ) -> List[dict]:
        user_prompt = self._user_prompt(payload, src, dst)
        try:
            resp = self.llm.invoke(
                [("system", system), *(history or []), ("human", user_prompt)]
            )
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(
                f"Failed to get translation from LLM (provider {self.provider}, model {self.model}): {e}. "
                f"Check the key/endpoint availability (for openai: ensure LM Studio/vLLM is running)."
            ) from e

        content = resp.content if hasattr(resp, "content") else str(resp)
        return self._parse(content)

    @staticmethod
    def _json_objects(s: str) -> List[str]:
        """All top-level {...} substrings, brace-matched and string-aware.

        Unlike a greedy regex, this won't fuse a brace from the model's reasoning with
        the answer's closing brace, and it skips braces inside string literals."""
        objs: List[str] = []
        depth = start = 0
        in_str = esc = False
        for i, ch in enumerate(s):
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                if depth == 0:
                    start = i
                depth += 1
            elif ch == "}" and depth > 0:
                depth -= 1
                if depth == 0:
                    objs.append(s[start:i + 1])
        return objs

    @staticmethod
    def _parse(content: str) -> List[dict]:
        """Extract translations from the model response, tolerating extra text."""
        # Reasoning models (gemma "<channel|>", others "</think>") echo the source text
        # before the answer; drop everything up to the last marker so that echo isn't
        # mistaken for a translation.
        for marker in ("<channel|>", "</think>", "</thought>"):
            if marker in content:
                content = content.rsplit(marker, 1)[-1]
        fallback: List[dict] = []
        for raw in Translator._json_objects(content):
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(data, dict) and isinstance(data.get("translations"), list):
                return data["translations"]
            if isinstance(data, list):
                fallback = fallback or data
        return fallback


_default_translator: Optional[Translator] = None


def get_translator() -> Translator:
    global _default_translator
    if _default_translator is None:
        _default_translator = Translator()
    return _default_translator
