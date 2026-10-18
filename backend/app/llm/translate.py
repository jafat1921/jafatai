"""Plain translation: the one place the app turns text from one language into another (TRANSLATE_LLM_MODEL).

TranslateGemma is trained on a single prompt (google/translategemma-27b-it chat template, also printed on
ollama.com/library/translategemma) and answers with the bare translation, so there is no JSON and no schema
here. Lines go out in small numbered chunks so neighbouring dialogue shares context; a chunk whose numbering
doesn't come back intact is asked again line by line. When the model isn't installed, the creative model gets
the same prompt. Aerab is the caller's job (aerab.finish / finish_lines_sync), exactly as for any other writer.

Licence (backend only, never in the UI): Gemma terms, commercial use allowed within the prohibited-use policy.
"""
import asyncio
import logging
import re
from typing import Callable

from app.config import get_settings
from app.llm.client import LLMError, bare_tag, chat_sync, installed_models, model_for
from app.voices import lang_name

log = logging.getLogger("mixai.llm")

# app language codes TranslateGemma lists (its 55 WMT24++ languages and more); bal, skr, yue aren't there
SUPPORTED = set(
    "en ur pa pnb sd ps hi bn ar fa es fr de zh ja ko tr ru pt it id ms sw ta te mr gu kn ml or as ne si ks my "
    "th vi km lo tl uk pl nl sv da no fi el he cs ro hu bg sr hr sk az kk uz tg ku am ha yo ig zu so".split()
)
# where the bare app code would leave the script or variety to chance
_CODES = {"ur": "ur-PK", "pnb": "pa-Arab", "sd": "sd-Arab", "zh": "zh-Hans"}
_NAMES = {"zh": "Chinese", "pnb": "Punjabi", "or": "Oriya", "km": "Central Khmer"}
_ALIASES = {"pa-arab": "pnb", "pa-pk": "pnb", "pnb-arab": "pnb", "zh-cn": "zh", "zh-hans": "zh"}

CHUNK_LINES = 8
# the model card gives 2K tokens of input; Urdu and Arabic spend far more tokens per character than English
CHUNK_CHARS = 900

_DIGITS = str.maketrans({**{chr(0x0660 + d): str(d) for d in range(10)}, **{chr(0x06F0 + d): str(d) for d in range(10)}})
_NUMBERED = re.compile(r"^\s*([0-9٠-٩۰-۹]+)\s*[.)۔:]\s*(.*)$")

_said: set[str] = set()


def base(language: str | None) -> str:
    low = (language or "").strip().lower().replace("_", "-")
    return _ALIASES.get(low) or low.split("-")[0]


def lang_tag(language: str) -> tuple[str, str]:
    """(code, name) as the prompt wants them, e.g. ("ur-PK", "Urdu")."""
    b = base(language)
    return _CODES.get(b, b), _NAMES.get(b) or lang_name(b)


def prompt(text: str, source: str, target: str) -> str:
    sc, sn = lang_tag(source)
    tc, tn = lang_tag(target)
    # verbatim from the model card, two blank lines before the text included
    return (
        f"You are a professional {sn} ({sc}) to {tn} ({tc}) translator. Your goal is to accurately convey the "
        f"meaning and nuances of the original {sn} text while adhering to {tn} grammar, vocabulary, and cultural "
        f"sensitivities.\n"
        f"Produce only the {tn} translation, without any additional explanations or commentary. Please translate "
        f"the following {sn} text into {tn}:\n\n\n"
        f"{text}"
    )


def _once(key: str, msg: str, *args) -> None:
    if key not in _said:
        _said.add(key)
        log.info(msg, *args)


def translator(source: str | None, target: str | None) -> str | None:
    """The TranslateGemma model when it is set, installed and knows both languages; None means the caller keeps
    its old path. Not installed is logged once, not per call."""
    name = get_settings().translate_llm_model.strip()
    if not name or not source or not target:
        return None
    if base(source) not in SUPPORTED or base(target) not in SUPPORTED or base(source) == base(target):
        return None
    try:
        have = asyncio.run(installed_models())
    except LLMError as e:
        _once(f"ask:{name}", "couldn't list the LLM models (%s); translating with the creative model", e)
        return None
    if bare_tag(name) not in have:
        _once(f"missing:{name}", "%s isn't installed (ollama pull %s); translating with the creative model", name,
              name)
        return None
    return name


def keep_alive(model: str) -> str | None:
    # 27B of TranslateGemma idling on the card for Ollama's default 5 minutes starves ComfyUI
    s = get_settings()
    name = s.translate_llm_model.strip()
    return (s.ollama_keep_alive_big or None) if name and model == name else None


def _ask(model: str, text: str, source: str, target: str, tick) -> str:
    res = chat_sync("creative", [{"role": "user", "content": prompt(text, source, target)}], model=model,
                    think=False, temperature=0.0, max_tokens=min(4000, 200 + 4 * len(text)), timeout=240.0,
                    tick=tick, keep_alive=keep_alive(model))
    return res.content.strip()


def parse_numbered(answer: str, n: int) -> list[str] | None:
    """Exactly n non-empty lines numbered 1..n in order (Urdu digits are fine), else None."""
    rows = [r for r in answer.splitlines() if r.strip()]
    if len(rows) != n:
        return None
    out = []
    for k, row in enumerate(rows, 1):
        m = _NUMBERED.match(row)
        if not m or int(m.group(1).translate(_DIGITS)) != k or not m.group(2).strip():
            return None
        out.append(m.group(2).strip())
    return out


def chunks(items: list[tuple[int, str]]) -> list[list[tuple[int, str]]]:
    out, cur, size = [], [], 0
    for i, text in items:
        alone = "\n" in text
        if cur and (alone or len(cur) >= CHUNK_LINES or size + len(text) > CHUNK_CHARS):
            out.append(cur)
            cur, size = [], 0
        cur.append((i, text))
        size += len(text)
        if alone:
            out.append(cur)
            cur, size = [], 0
    if cur:
        out.append(cur)
    return out


def translate(texts: list[str], source: str, target: str, *, tick: Callable[[], None] | None = None,
              model: str | None = None) -> list[str]:
    """One translation per text, same order. Empty texts stay empty. Raises LLMError when the model fails."""
    model = model or translator(source, target) or model_for("creative")
    out = ["" for _ in texts]
    todo = [(i, t.strip()) for i, t in enumerate(texts) if t and t.strip()]
    for chunk in chunks(todo):
        if len(chunk) == 1:
            i, text = chunk[0]
            out[i] = _ask(model, text, source, target, tick)
            continue
        numbered = "\n".join(f"{k}. {text}" for k, (_, text) in enumerate(chunk, 1))
        got = parse_numbered(_ask(model, numbered, source, target, tick), len(chunk))
        if got is None:
            log.info("%s merged or renumbered a %d-line chunk; asking line by line", model, len(chunk))
            got = [_ask(model, text, source, target, tick) for _, text in chunk]
        for (i, _), line in zip(chunk, got):
            out[i] = line
    return out
