"""The words of a dub: translation in batches (TranslateGemma through app.llm.translate when installed, then
the editor for lines over their time budget or with glossary terms; else one creative call with budgets and
glossary pinned), the careful mode's self-review, a shorter line when a take overruns, and the word error rate the verify stage uses."""
import logging
import re

from pydantic import BaseModel

from app import aerab
from app.voices import lang_name

log = logging.getLogger("mixai.dub")

BATCH = 12
# spoken words per second at a relaxed dubbing pace; only a budget hint for the LLM
WORDS_PER_S = {"ja": 3.0, "zh": 3.2, "es": 2.9, "it": 2.8, "fr": 2.7}
WPS_DEFAULT = 2.5


class Line(BaseModel):
    id: str
    text: str


class Lines(BaseModel):
    lines: list[Line]


class Shorter(BaseModel):
    text: str


def word_budget(slot_s: float, lang: str) -> int:
    return max(1, round(slot_s * WORDS_PER_S.get(lang, WPS_DEFAULT)))


def glossary_rules(glossary: list[dict], lang: str) -> list[str]:
    out = []
    for g in glossary or []:
        src = " ".join(str(g.get("source") or "").split())
        if not src:
            continue
        tgt = " ".join(str((g.get("target") or {}).get(lang) or "").split())
        rule = f'"{src}" → "{tgt}"' if tgt else f'"{src}" stays "{src}"'
        if g.get("note"):
            rule += f" ({' '.join(str(g['note']).split())[:200]})"
        out.append(rule)
    return out


def _script_rule(lang: str) -> str:
    if lang == "ur":
        rule = "Write Urdu in Urdu script (not Roman Urdu, not Hindi), the way people actually speak it."
    else:
        rule = f"Write {lang_name(lang)} in its usual script, the way people actually speak it."
    marks = aerab.writing_rule(lang)
    return f"{rule} {marks}" if marks else rule


def _budget(item: dict, lang: str) -> str:
    slot = max(0.3, float(item["end"]) - float(item["start"]))
    return f"{slot:.1f} s, at most ~{word_budget(slot, lang)} words"


def translate_messages(batch: list[dict], src: str | None, lang: str, glossary: list[dict]) -> list[dict]:
    rules = [
        f"You translate film dialogue for dubbing from {lang_name(src) if src else 'the original language'} "
        f"into {lang_name(lang)}.",
        "Each line has a time budget: the actor has to say your line in that time, so stay within the word "
        "budget. Shorter and natural beats long and literal.",
        _script_rule(lang),
        "Keep the speaker's tone and register. Keep names and numbers. Never merge, split or skip lines.",
    ]
    gl = glossary_rules(glossary, lang)
    if gl:
        rules.append("Glossary, use exactly:\n" + "\n".join(gl))
    rules.append('Reply as JSON: {"lines": [{"id": the line id, "text": your translation}]}, one per line.')
    user = "\n".join(f"{s['id']} | {_budget(s, lang)} | {s.get('speaker') or 'Speaker'} | {s['text']}" for s in batch)
    return [{"role": "system", "content": "\n\n".join(rules)}, {"role": "user", "content": user}]


def review_messages(batch: list[dict], drafts: dict[str, str], src: str | None, lang: str,
                    glossary: list[dict]) -> list[dict]:
    rules = [
        f"You are the dubbing editor checking a translation from {lang_name(src) if src else 'the original'} "
        f"into {lang_name(lang)}.",
        "For each line fix mistranslations, stiff or unnatural phrasing and wrong glossary terms, and keep it "
        "inside its time budget. A line that is already good comes back unchanged.",
        _script_rule(lang),
    ]
    gl = glossary_rules(glossary, lang)
    if gl:
        rules.append("Glossary, use exactly:\n" + "\n".join(gl))
    rules.append('Reply as JSON: {"lines": [{"id": the line id, "text": the final line}]}, one per line.')
    user = "\n".join(f"{s['id']} | {_budget(s, lang)} | source: {s['text']} | draft: {drafts.get(s['id'], '')}"
                     for s in batch)
    return [{"role": "system", "content": "\n\n".join(rules)}, {"role": "user", "content": user}]


def shorter_messages(text: str, source: str, slot_s: float, lang: str, glossary: list[dict]) -> list[dict]:
    rules = [
        f"You shorten {lang_name(lang)} dubbing lines so an actor can say them in the time there is.",
        f"Rewrite the line so it can be said in {slot_s:.1f} seconds (about {word_budget(slot_s, lang)} words). "
        "Keep the meaning, the names and the tone. " + _script_rule(lang),
    ]
    gl = glossary_rules(glossary, lang)
    if gl:
        rules.append("Glossary, use exactly:\n" + "\n".join(gl))
    rules.append('Reply as JSON: {"text": "the shorter line"}.')
    user = f"Original: {source}\nCurrent line: {text}"
    return [{"role": "system", "content": "\n\n".join(rules)}, {"role": "user", "content": user}]


ASK = dict(think=False, temperature=0.3, max_tokens=4000, timeout=240.0)


def over_budget(text: str, item: dict, lang: str) -> bool:
    budget = word_budget(max(0.3, float(item["end"]) - float(item["start"])), lang)
    # the budget is a hint and the fit stage still has atempo, so only a clear overrun goes to the editor
    return len(words_of(text)) > max(budget + 1, budget * 1.2)


def pinned(text: str, glossary: list[dict]) -> bool:
    low = (text or "").casefold()
    return any(src and src.casefold() in low for src in (" ".join(str(g.get("source") or "").split())
                                                          for g in glossary or []))


def _faithful_then_fit(batch: list[dict], src: str, lang: str, glossary: list[dict], careful: bool,
                       tick) -> dict[str, str]:
    from app.llm import LLMError, chat_sync
    from app.llm.translate import translate

    drafts = translate([s["text"] for s in batch], src, lang, tick=tick)
    out = {s["id"]: " ".join(d.split()) for s, d in zip(batch, drafts)}
    # TranslateGemma knows nothing of the time budget or the glossary, so the editor (the creative model) only
    # sees the lines that need one of those; careful mode still reviews every line
    fix = [s for s in batch if careful or not out[s["id"]] or over_budget(out[s["id"]], s, lang)
           or pinned(s["text"], glossary)]
    if not fix:
        return out
    try:
        res = chat_sync("creative", review_messages(fix, out, src, lang, glossary), tick=tick, schema=Lines,
                        **{**ASK, "temperature": 0.2})
    except LLMError as e:
        log.warning("dub editor pass failed (%s); keeping the plain translations", e)
        return out
    out.update({x.id: " ".join(x.text.split()) for x in res.data.lines if x.id in out and x.text.strip()})
    return out


def translate_batch(batch: list[dict], src: str | None, lang: str, glossary: list[dict], careful: bool,
                    tick=None) -> dict[str, str]:
    from app.llm import LLMError, chat_sync
    from app.llm.translate import translator

    if translator(src, lang):
        try:
            return _faithful_then_fit(batch, src, lang, glossary, careful, tick)
        except LLMError as e:
            log.warning("translation model failed (%s); the creative model translates this batch", e)
    # no TranslateGemma: one creative call that translates within the budgets and glossary, as before
    res = chat_sync("creative", translate_messages(batch, src, lang, glossary), tick=tick, schema=Lines, **ASK)
    out = {x.id: " ".join(x.text.split()) for x in res.data.lines}
    if careful:
        res = chat_sync("creative", review_messages(batch, out, src, lang, glossary), tick=tick, schema=Lines,
                        **{**ASK, "temperature": 0.2})
        # the editor may drop a line; its draft stands then
        out.update({x.id: " ".join(x.text.split()) for x in res.data.lines if x.text.strip()})
    return out


def shorter_line(text: str, source: str, slot_s: float, lang: str, glossary: list[dict], tick=None) -> str:
    from app.llm import chat_sync

    res = chat_sync("creative", shorter_messages(text, source, slot_s, lang, glossary), tick=tick, schema=Shorter,
                    **{**ASK, "max_tokens": 600})
    return " ".join(res.data.text.split())


_NOT_WORD = re.compile(r"[^\w\s']", re.U)


def words_of(text: str) -> list[str]:
    return _NOT_WORD.sub(" ", aerab.strip(text or "").lower()).split()


def wer(reference: str, heard: str) -> float:
    ref, hyp = words_of(reference), words_of(heard)
    if not ref:
        return 0.0 if not hyp else 1.0
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return round(prev[-1] / len(ref), 3)
