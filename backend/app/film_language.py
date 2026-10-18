"""Keeping a film's words in the film's language.

The small writer and planner models are told "the film is in Urdu" and still hand back English lines now and
then, or a title like "روشni (The Light of Ramadan)". These checks catch Latin text where the language is
written in another script, and put it through TranslateGemma; the caller's aerab pass marks the result.
"""
import logging
import re
from typing import Callable

from app import speech_language as sl
from app import storyboard as sb
from app.llm import LLMError

log = logging.getLogger("mixai.film_language")

# a scene heading reads like a cue to screenplay_lines; the action under it isn't speech
_HEADING = re.compile(r"^(INT|EXT|I/E|INT\./EXT)\b")
_PARENS = re.compile(r"\s*[(\[][^)\]]*[)\]]")


def own_script(language: str | None) -> str | None:
    """The script a film language is written in, None when it is Latin (nothing to enforce) or unknown."""
    s = sl.script_of(language)
    return None if s in (None, "latin") else s


def off_script(text: str, language: str | None) -> bool:
    """More Latin letters than letters of the language's own script: an English line in an Urdu film."""
    want = own_script(language)
    if want is None:
        return False
    counts = sl.letters_by_script(text)
    return counts.get("latin", 0) > counts.get(want, 0)


def pure(text: str, language: str | None) -> bool:
    want = own_script(language)
    counts = sl.letters_by_script(text)
    return bool(counts) and want is not None and set(counts) == {want}


def _translate(texts: list[str], language: str, tick) -> list[str] | None:
    from app.llm import translate as tr

    try:
        return tr.translate(texts, "en", language, tick=tick)
    except LLMError as e:
        log.warning("couldn't translate %d line(s) into %s: %s", len(texts), language, e)
        return None


def localise(texts: list[str], language: str | None, tick: Callable[[], None] | None = None) -> list[str]:
    """The lines that came back in English, translated; the rest untouched. Same order and length."""
    idx = [i for i, t in enumerate(texts) if t and off_script(t, language)]
    if not idx:
        return list(texts)
    done = _translate([texts[i] for i in idx], language, tick) or []
    out = list(texts)
    for i, t in zip(idx, done):
        if t.strip() and not off_script(t, language):
            out[i] = t.strip()
    log.info("translated %d English line(s) into %s", sum(out[i] != texts[i] for i in idx), language)
    return out


def localise_script(script: str, language: str | None, tick: Callable[[], None] | None = None) -> str:
    """A scene's spoken lines in the film's language. Headings, cues and action stay English (SCRIPT_RULES)."""
    if own_script(language) is None or not script:
        return script
    rows = script.split("\n")
    # screenplay_lines yields once per raw line, so the two line up
    spoken = [i for i, (kind, cue, line) in enumerate(sb.screenplay_lines(script))
              if kind == "dialogue" and not _HEADING.match(cue or "") and off_script(line, language)]
    if not spoken:
        return script
    done = localise([rows[i].strip() for i in spoken], language, tick)
    for i, t in zip(spoken, done):
        rows[i] = t
    return "\n".join(rows)


def _latin_only(text: str) -> bool:
    return set(sl.letters_by_script(text)) == {"latin"}


def clean_titles(english: str, local: str, language: str | None,
                 tick: Callable[[], None] | None = None) -> tuple[str, str]:
    """(English title, title in the film's script). The local one is pure script or "" (the card then shows the
    English title alone); an English title that carries the local one too keeps only its English."""
    english, local = (english or "").strip(), (local or "").strip()
    if own_script(language) is None:
        return english, local
    if not _latin_only(english) and "latin" in sl.letters_by_script(english):
        # "روشنی (The Light of Ramadan)" or "The Light of Ramadan (روشنی)": keep the English half
        parts = re.findall(r"[(\[]([^)\]]*)[)\]]", english) + [_PARENS.sub("", english)]
        english = next((x.strip() for x in parts if _latin_only(x)), english)
    local = _PARENS.sub("", local).strip(" -:|·")
    if pure(local, language):
        return english, local
    if not _latin_only(english):
        return english, ""
    got = _translate([english], language, tick)
    t = _PARENS.sub("", (got or [""])[0]).strip(" -:|·\"'")
    return english, t if pure(t, language) else ""
