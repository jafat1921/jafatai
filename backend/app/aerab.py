"""Aerab / tashkeel for the Arabic-script languages (contract v23): Urdu, Arabic, Persian, Pashto, Sindhi and
Punjabi in Shahmukhi. Without the short vowels the TTS, song and video models guess, and guess wrong.

The LLM only proposes the marks. They are then moved onto the writer's own letters: the two letter
sequences are aligned, marks land only where they agree, and a line the LLM rewrote too much (under
MIN_ALIGNED of its letters line up) is left exactly as it was written.
"""
import asyncio
import logging
import re
import time
import unicodedata
from difflib import SequenceMatcher
from typing import NamedTuple

from pydantic import BaseModel

log = logging.getLogger("mixai.aerab")

ARABIC_SCRIPT_LANGS = ("ur", "ar", "fa", "ps", "sd", "pnb")
NAMES = {"ur": "Urdu", "ar": "Arabic", "fa": "Persian", "ps": "Pashto", "sd": "Sindhi", "pnb": "Punjabi (Shahmukhi)"}
TERMS = {"ur": "aerab", "ar": "tashkeel", "fa": "harakat", "ps": "harakat", "sd": "aerab", "pnb": "aerab"}
# Punjabi in Arabic letters goes by several codes
_ALIASES = {"pa-arab": "pnb", "pa-pk": "pnb", "pnb-arab": "pnb"}
# codes that mean "we don't know": the letters decide
_GUESS = {"", "auto", "unknown", "und", "mul"}

# harakat and the small Quranic-style signs; hamza above / below (0654, 0655) are spelling, not marks
_MARKS = re.compile("[ؐ-ًؚ-ٖٓ-ٰٟۖ-ۜ۟-۪ۨ-ۭ]")
# invisible joiners and the tatweel: allowed to come and go, never compared
_SOFT = "‌‍ـ"
_ARABIC_SCRIPT = re.compile("[؀-ۿݐ-ݿࢠ-ࣿ]")
_MARKER = re.compile(r"^\s*\[[^\]]+\]\s*$")

# Code points an LLM likes to swap in for the ones each language uses. Only the alignment folds them:
# the writer's own letters are what ends up in the text, so Arabic keeps ي ى ك ة and Urdu keeps ی ک ہ.
# Letters are compared decomposed (NFD), so ۂ ۀ ۓ ئ ؤ arrive as their base letter plus a hamza above,
# and the hamza is ignored like the joiners (_IGNORE).
_URDU_FOLD = {"ي": "ی", "ى": "ی", "ے": "ی", "ك": "ک", "ه": "ہ", "ە": "ہ", "ة": "ہ", "ۃ": "ہ"}
_FOLDS = {
    "ur": _URDU_FOLD,
    "pnb": _URDU_FOLD,
    "fa": {"ي": "ی", "ى": "ی", "ك": "ک", "ہ": "ه", "ە": "ه", "ۃ": "ة"},
    # Pashto writes ي and ی as two different letters, so they never fold
    "ps": {"ى": "ی", "ك": "ک", "ہ": "ه", "ە": "ه", "ۃ": "ة"},
    # Sindhi's ye is ي and its k is ڪ (ک is kh)
    "sd": {"ی": "ي", "ى": "ي", "ك": "ڪ", "ہ": "ه", "ە": "ه"},
    # vocalising MSA, models like to add or drop a hamza seat or write the wasla; the writer's alif stands
    "ar": {"ی": "ي", "ک": "ك", "ہ": "ه", "ە": "ه", "ۃ": "ة", "ٱ": "ا"},
}
# every language: Arabic-Indic and Persian digits, and the script's own punctuation
_COMMON_FOLD = {**{chr(0x0660 + d): str(d) for d in range(10)}, **{chr(0x06F0 + d): str(d) for d in range(10)},
                "۔": ".", "،": ",", "؟": "?", "؛": ";", "٪": "%", "٫": ".", "٬": ","}
_FOLD_TABLES = {k: str.maketrans({**_COMMON_FOLD, **v}) for k, v in _FOLDS.items()}
# never compared: joiners, tatweel, direction marks, BOM, and the hamza above / below a decomposed letter
_IGNORE = _SOFT + "‎‏؜﻿ٕٔ"
# Arabic presentation forms (old InPage exports, some models): compared as the letters they stand for
_PRESENTATION = re.compile("[ﭐ-﷿ﹰ-﻿]")
# a madda the LLM puts on a bare alif turns it into آ, which is a different letter, so it never transfers
_MADDA = "ٓ"

# letters that give a language away
_SINDHI = set("ٻڄڃڇڊڌڍڏڙڦڱڳڻڪٽٺ")
_PASHTO = set("ڭډړږښګڼۍېټځڅ")
_SHAHMUKHI = set("ݨݪ")
_URDU = set("ےۓںٹڈڑۂہھ")
_PERSO = set("پچژگیک")
_ARABIC = set("ةىيك")
# common words, for text whose letters are all shared
_HINTS = {
    "ur": {"کی", "کا", "کے", "ہے", "ہیں", "نہیں", "میں", "اور", "کو", "سے", "نے", "تھا", "تھی", "گا", "گی", "یہ", "وہ"},
    "fa": {"است", "را", "که", "این", "آن", "می", "از", "هست", "نیست", "بود", "برای", "هم", "شد"},
    "ar": {"في", "من", "على", "إلى", "الى", "التي", "الذي", "هذا", "هذه", "كان", "أن", "إن", "لا", "ما"},
}
# short function words carry no weight in the coverage measure
_FUNCTION = {"و", "کی", "کا", "کے", "کو", "سے", "ہے", "نے", "میں", "تو", "بھی", "یہ", "وہ", "اور", "پر", "نہ",
             "في", "من", "ما", "لا", "يا", "على", "عن", "از", "به", "که", "را", "با", "این", "آن", "تا", "او",
             "د", "په", "چې", "دا", "۾", "جو", "جي", "کان"}

MAX_LINES = 600
# lines and sentences per pass; a long prose line is split into sentences first (SPLIT_OVER)
MAX_UNITS = 3000
BATCH = 40
RETRY_BATCH = 10
# characters per call: small enough that one call stays well inside a proxy's 60 s
BATCH_CHARS = 700
SPLIT_OVER = 100
# share of letters that must line up with the LLM's before any of its marks are used
MIN_ALIGNED = 0.8
# /api/text/aerab answers inside this, with whatever is marked by then
SYNC_BUDGET_S = 45.0
# no new call is started with less than this left in the budget
MIN_CALL_S = 6.0
# share of words that must carry a mark; Arabic is vocalised in full, the others leave long vowels bare
MIN_COVERAGE = {"ar": 0.7}
MIN_COVERAGE_DEFAULT = 0.5


def is_mark(ch: str) -> bool:
    return bool(_MARKS.fullmatch(ch))


def strip(text: str) -> str:
    return _MARKS.sub("", text)


def _is_letter(ch: str) -> bool:
    return bool(_ARABIC_SCRIPT.match(ch)) and ch.isalpha() and ch not in _SOFT


def has_script(text: str) -> bool:
    return any(_is_letter(ch) for ch in text or "")


def needs_marks(line: str) -> bool:
    return bool(_ARABIC_SCRIPT.search(line)) and not _MARKER.match(line) and has_script(line)


def unmarked(line: str) -> bool:
    """Arabic-script text with (almost) no marks yet; a line the writer marked themselves is theirs."""
    if not needs_marks(line):
        return False
    letters = sum(1 for ch in line if _ARABIC_SCRIPT.match(ch) and not is_mark(ch))
    return sum(1 for ch in line if is_mark(ch)) * 6 < letters


# ---------------------------------------------------------------- which language

def detect_language(text: str) -> str | None:
    """The Arabic-script language `text` is in, from the letters it uses; None when it has none."""
    letters = [ch for ch in text or "" if _is_letter(ch)]
    if len(letters) < 2:
        return None
    if any(ch in _SHAHMUKHI for ch in letters):
        return "pnb"
    scores = {"ur": sum(ch in _URDU for ch in letters), "sd": sum(ch in _SINDHI for ch in letters),
              "ps": sum(ch in _PASHTO for ch in letters)}
    best = max(scores, key=scores.get)  # a tie goes to Urdu, the first key
    if scores[best]:
        return best
    words = {strip(w) for w in re.findall(r"\S+", text)}
    hints = {k: len(words & v) for k, v in _HINTS.items()}
    perso = any(ch in _PERSO for ch in letters)
    arabic = any(ch in _ARABIC for ch in letters)
    if perso:
        return "ur" if hints["ur"] > hints["fa"] else "fa"
    if arabic:
        # Urdu typed on an Arabic keyboard still reads like Urdu
        return "ur" if hints["ur"] > hints["ar"] else "ar"
    if hints["ar"] > hints["ur"] or hints["fa"] > hints["ur"]:
        return "ar" if hints["ar"] >= hints["fa"] else "fa"
    # only letters every one of them shares: read it as Urdu, the app's main language
    return "ur"


def resolve(language: str | None, text: str = "") -> str | None:
    """The Arabic-script language code to mark `text` in, or None when it isn't one."""
    code = (language or "").strip().lower().replace("_", "-")
    if "latn" in code:
        return None  # Roman Urdu and friends: Latin letters, nothing to mark
    code = _ALIASES.get(code, code)
    base = code.split("-")[0]
    if base in ARABIC_SCRIPT_LANGS:
        return base
    if base == "pa":
        # Punjabi is Gurmukhi or Shahmukhi; Arabic letters mean the second
        return "pnb" if detect_language(text) else None
    if code in _GUESS:
        return detect_language(text)
    return None


def enabled_languages() -> set[str]:
    from app.config import get_settings

    s = get_settings()
    if not s.urdu_aerab:
        return set()
    wanted = {_ALIASES.get(x.strip().lower(), x.strip().lower()) for x in (s.aerab_languages or "").split(",")}
    return wanted & set(ARABIC_SCRIPT_LANGS)


def target(language: str | None, text: str = "") -> str | None:
    """`resolve`, limited to the languages aerab is switched on for."""
    lang = resolve(language, text)
    return lang if lang in enabled_languages() else None


def applies(language: str | None, text: str) -> bool:
    """True when `text` has Arabic-script lines in a language aerab is on for."""
    return bool(text) and target(language, text) is not None and any(map(needs_marks, text.split("\n")))


def coverage(text: str) -> float:
    """Share of the Arabic-script words carrying at least one mark; one-letter and function words don't count."""
    total = covered = 0
    for raw in (text or "").split():
        letters = "".join(ch for ch in raw if _is_letter(ch))
        if len(letters) < 2 or letters in _FUNCTION:
            continue
        total += 1
        covered += any(is_mark(ch) for ch in raw)
    return covered / total if total else 1.0


def min_coverage(language: str | None) -> float:
    return MIN_COVERAGE.get(language or "", MIN_COVERAGE_DEFAULT)


# ---------------------------------------------------------------- what to ask for

# (what the marks are called, which marks, which letters must not change)
_RULES = {
    "ur": ("aerab (Urdu diacritics, harakat)",
           "zabar (َ), zer (ِ), pesh (ُ), jazm (ْ) on silent letters, tashdeed (ّ) on doubled letters, tanween (ً) "
           "where Urdu uses it (fauran فوراً), khari zabar (ٰ) where it is read, and the izafat zer between joined "
           "words (dil-e-nadan دِلِ ناداں)",
           "keep the Urdu letters (ی ک ہ ے ں ھ) as they are"),
    "ar": ("tashkeel (full Arabic vocalisation)",
           "fatha (َ), kasra (ِ), damma (ُ), sukun (ْ), shadda (ّ), tanwin fath (ً), tanwin kasr (ٍ) and tanwin damm "
           "(ٌ), the superscript alef (ٰ) where it is read, and the case ending (i'rab) on the last letter of every "
           "word: fully vocalised Modern Standard Arabic, as in a vocalised text for reciting",
           "keep the Arabic letters (ي ى ك ة ه) and every hamza seat (أ إ آ ؤ ئ ء) exactly as written"),
    "fa": ("harakat (Persian e'rab)",
           "zabar (َ), zir (ِ), pish (ُ), sukun (ْ), tashdid (ّ), and the ezafe kasra (ِ) on the last letter of a "
           "word joined to the next by ezafe (ketab-e man کتابِ من)",
           "keep the Persian letters (ی ک ه) as they are"),
    "ps": ("harakat (Pashto zwar, zer, pesh)",
           "zwar / zabar (َ), zer (ِ), pesh (ُ), sukun (ْ) and tashdid (ّ), the way vocalised Pashto readers mark "
           "them",
           "keep the Pashto letters (ټ ډ ړ ږ ښ ګ ڼ ې ۍ ي ی) as they are"),
    "sd": ("aerab (Sindhi harakat)",
           "zabar (َ), zer (ِ), pesh (ُ), sukun (ْ) and shad (ّ), the way vocalised Sindhi readers mark them",
           "keep the Sindhi letters (ڪ ک ٻ ڄ ڃ ڇ ڊ ڌ ڍ ڏ ڙ ڦ ڱ ڳ ڻ ي) as they are"),
    "pnb": ("aerab (Shahmukhi Punjabi)",
            "zabar (َ), zer (ِ), pesh (ُ), jazm (ْ) on silent letters, tashdeed (ّ) on doubled letters and the "
            "izafat zer, as in Urdu",
            "keep the Shahmukhi letters (ݨ ڑ ں ے ی ک ہ ھ) as they are"),
}


def writing_rule(language: str | None, text: str = "") -> str:
    """The first-pass rule for a writer's system prompt, or "" when the output isn't Arabic-script.

    `text` is the user's input: with no language given, its letters say which language is coming."""
    lang = target(language, text)
    if lang is None:
        return ""
    name, (_, marks, letters) = NAMES[lang], _RULES[lang]
    head = (f"Write {name} in its own script" if resolve(language) == lang
            else f"Wherever you write {name}, write it in its own script")
    return (f"{head} WITH FULL {TERMS[lang]} on every word, as described: {marks}. Never Roman letters, never "
            f"a bare unmarked {name} word; {letters}. Names, markers and English words stay as they are.")


class Marked(BaseModel):
    lines: list[str]


# zabar, zer, pesh, jazm, tashdeed and the izafat zer in one plain sentence; long vowels stay bare
_EXAMPLE = ("شہر لاہور کے بچے نے صبر اور محبت سے علم سیکھا۔",
            "شَہْرِ لاہور کے بَچّے نے صَبْر اَور مُحَبَّت سے عِلْم سیکھا۔")


def messages(lines: list[str], language: str | None = None, strict: bool = False) -> list[dict]:
    lang = language if language in _RULES else "ur"
    name, (what, marks, letters) = NAMES[lang], _RULES[lang]
    rules = [
        f"You add {what} to {name} text that will be read aloud, spoken or sung: prose, dialogue, verse. "
        "Every word must be pronounced correctly from the marks alone.",
        f"For each line, return the same line with full marks: {marks}.",
        "Mark the vowel of every letter whose sound is not obvious from the spelling."
        + (" Arabic is vocalised in full: every letter gets its mark." if lang == "ar"
           else " Long vowels written with alif, wao or ye need no extra mark."),
        f"Never add, remove, replace or reorder a letter or a word. Do not correct spelling, do not translate, "
        f"{letters}, keep the spaces and the punctuation.",
        f"Lines that are not {name} come back unchanged.",
        'Reply as JSON: {"lines": [the lines in the same order, one string per line]}. Same number of lines.',
    ]
    if lang in ("ur", "pnb"):
        rules.insert(3, f"Example. Line: {_EXAMPLE[0]}\nMarked: {_EXAMPLE[1]}")
    if strict:
        rules.insert(2, "An earlier pass left most words of these lines bare. Mark EVERY word this time.")
    user = "\n".join(f"{i + 1}. {line}" for i, line in enumerate(lines))
    return [{"role": "system", "content": "\n".join(rules)}, {"role": "user", "content": user}]


# ---------------------------------------------------------------- putting marks back

def _expand(ch: str) -> str:
    if _PRESENTATION.match(ch):
        ch = unicodedata.normalize("NFKC", ch)
    return unicodedata.normalize("NFD", ch)


def _clusters(text: str, fold: dict) -> list[list]:
    """[folded letter, marks, position in `text`, marks typed after it] for every letter (and digit, and
    punctuation mark); spaces and _IGNORE are dropped. "marks" also holds what a ligature carried inside it."""
    out: list[list] = []
    for pos, raw in enumerate(text):
        if is_mark(raw):
            if out:
                out[-1][1] += raw
                out[-1][3] += raw
            continue
        if raw.isspace() or raw in _IGNORE:
            continue
        for ch in _expand(raw):
            if is_mark(ch):
                if out and ch != _MADDA:
                    out[-1][1] += ch
            elif not ch.isspace() and ch not in _IGNORE:
                out.append([ch.translate(fold), "", pos, ""])
    return out


def align(original: str, marked: str, language: str | None = None) -> tuple[str | None, float]:
    """(`original` with the marks from `marked`, share of letters that lined up). The text is None when
    fewer than MIN_ALIGNED of them did. Marks only land inside runs of letters the two agree on; the
    writer's letters are never touched, and marks the writer typed win over the LLM's."""
    fold = _FOLD_TABLES.get(language or "ur", _FOLD_TABLES["ur"])
    src = _clusters(original, fold)
    got = _clusters(unicodedata.normalize("NFC", marked), fold)
    if not src:
        return original, 1.0
    sm = SequenceMatcher(None, [c[0] for c in src], [c[0] for c in got], autojunk=False)
    proposed: dict[int, str] = {}
    lined_up = 0
    for a, b, size in sm.get_matching_blocks():
        lined_up += size
        # a lone matching letter between two rewritten stretches is more likely luck than the same word
        if size >= 2 or size == len(src):
            for k in range(size):
                proposed[a + k] = got[b + k][1].replace(_MADDA, "")
    ratio = lined_up / max(len(src), len(got))
    if ratio < MIN_ALIGNED:
        return None, ratio
    at: dict[int, list[int]] = {}
    for j, c in enumerate(src):
        at.setdefault(c[2], []).append(j)
    out = []
    for pos, ch in enumerate(original):
        if is_mark(ch):
            continue
        out.append(ch)
        js = at.get(pos)
        if not js:
            continue
        if any(src[j][1] for j in js):
            out.append("".join(src[j][3] for j in js))
        else:
            out.append("".join(proposed.get(j, "") for j in js))
    return "".join(out), ratio


def transfer(original: str, marked: str, language: str | None = None) -> str | None:
    """`original` with the marks from `marked`, or None when the two spell too different a line."""
    return align(original, marked, language)[0]


def _unnumber(line: str, n: int) -> str:
    return re.sub(rf"^\s*{n}\s*[.)\-:]\s*", "", line)


def _apply(rows: list[str], idx: list[int], proposed: list[str], language: str | None) -> tuple[set[int], list[float]]:
    """Marks the rows at `idx` in place from `proposed`: (rows refused, how well each one lined up)."""
    refused, ratios = set(), []
    for k, i in enumerate(idx):
        got, ratio = align(rows[i], _unnumber(proposed[k], k + 1), language) if k < len(proposed) else (None, 0.0)
        ratios.append(ratio)
        if got is None:
            refused.add(i)
        else:
            rows[i] = got
    return refused, ratios


def merge(text: str, proposed: list[str], language: str | None = None) -> tuple[str, int, int]:
    """Put the proposed lines back into `text`: (new text, lines marked, lines kept as written)."""
    rows = text.split("\n")
    before = list(rows)
    todo = [i for i, row in enumerate(rows) if needs_marks(row)]
    refused, _ = _apply(rows, todo, proposed, language)
    return "\n".join(rows), sum(rows[i] != before[i] for i in todo), len(refused)


def lines_to_mark(text: str) -> list[str]:
    return [row for row in text.split("\n") if needs_marks(row)][:MAX_LINES]


# ---------------------------------------------------------------- prose: sentences, not paragraphs

# the end of a sentence: its stop (and a closing quote), then the space that is kept as it was
_SENTENCE_END = re.compile(r"[۔؟!?.]+[\"'”’»)\]]*(\s+)")


def sentences(row: str) -> list[str]:
    """`row` as [sentence, gap, sentence, ...]; "".join() gives it back exactly. Short rows stay whole."""
    if len(row) <= SPLIT_OVER:
        return [row]
    out, at = [], 0
    for m in _SENTENCE_END.finditer(row):
        out += [row[at:m.start(1)], m.group(1)]
        at = m.end(1)
    out.append(row[at:])
    return out


def units(text: str) -> list[str]:
    """The text cut into what the LLM sees (lines, and the sentences of long lines) and what it never
    sees (newlines, the spaces between sentences)."""
    out: list[str] = []
    for k, row in enumerate(text.split("\n")):
        if k:
            out.append("\n")
        out += sentences(row)
    return out


class Result(NamedTuple):
    text: str
    marked: int = 0
    kept: int = 0
    low_coverage: int = 0
    language: str | None = None
    complete: bool = True
    remaining_chars: int = 0
    coverage: float = 1.0
    replies: tuple = ()

    def stats(self) -> dict:
        return {"marked": self.marked, "kept": self.kept, "low_coverage": self.low_coverage}

    def out(self) -> dict:
        """The TextAerabOut fields."""
        return {"text": self.text, "language": self.language, **self.stats(), "complete": self.complete,
                "remaining_chars": self.remaining_chars, "coverage": round(self.coverage, 3)}


class _OutOfTime(Exception):
    pass


def _batches(parts: list[str], idx: list[int], size: int) -> list[list[int]]:
    """Up to `size` units a call, and no more than BATCH_CHARS characters unless one unit is longer."""
    out, cur, chars = [], [], 0
    for i in idx:
        n = len(parts[i])
        if cur and (len(cur) >= size or chars + n > BATCH_CHARS):
            out.append(cur)
            cur, chars = [], 0
        cur.append(i)
        chars += n
    return out + [cur] if cur else out


def _weak(rows: list[str], idx, lang: str) -> list[int]:
    return [i for i in idx if coverage(rows[i]) < min_coverage(lang)]


_missing_warned: set[str] = set()


async def marking_model() -> str | None:
    """AERAB_LLM_MODEL when the LLM server has it, else None (the creative model). The small default creative
    model left most words unmarked on the live server, so a bigger one is the default here."""
    from app.config import get_settings
    from app.llm import LLMError
    from app.llm.client import bare_tag, installed_models

    want = get_settings().aerab_llm_model.strip()
    if not want:
        return None
    try:
        have = await installed_models()
    except LLMError:
        return want  # can't list: let the call itself succeed or fail as before
    if bare_tag(want) in have:
        return want
    if want not in _missing_warned:
        _missing_warned.add(want)
        log.warning("aerab: %s isn't installed; using the creative model", want)
    return None


async def _run(text: str, language: str | None, budget: float | None = None, progress=None,
               keep_replies: bool = False) -> Result:
    from app.llm import LLMError, chat

    lang = resolve(language, text) or detect_language(text) or "ur"
    parts = units(text)
    wanted = [i for i, u in enumerate(parts) if needs_marks(u)]
    if not wanted:
        return Result(text, language=lang, coverage=coverage(text))
    todo = wanted[:MAX_UNITS]
    model = await marking_model()
    deadline = time.monotonic() + budget if budget else None
    before = list(parts)
    refused: set[int] = set()
    done: set[int] = set()
    replies: list[dict] = []
    total = sum(len(parts[i]) for i in todo) or 1

    async def ask(chunk: list[int], strict: bool):
        size = sum(len(parts[i]) for i in chunk)
        wait = min(180.0, 60.0 + size / 10)
        if deadline is not None:
            left = deadline - time.monotonic()
            if left < MIN_CALL_S:
                raise _OutOfTime
            wait = min(wait, left)
        sent = [parts[i] for i in chunk]
        call = chat("creative", messages(sent, lang, strict), schema=Marked, think=False,
                    temperature=0.2, max_tokens=min(4000, 300 + 3 * size), timeout=wait, model=model)
        try:
            # the budget covers chat()'s own JSON repair call as well
            res = await (asyncio.wait_for(call, wait) if deadline is not None else call)
        except asyncio.TimeoutError:
            raise _OutOfTime from None
        except LLMError:
            if deadline is not None and time.monotonic() >= deadline - 1:
                raise _OutOfTime from None
            raise
        bad, ratios = _apply(parts, chunk, res.data.lines, lang)
        log.info("aerab %s %s: %d units, %d chars, %.1f s, accepted %d, refused %d, aligned %.2f",
                 res.model, "retry" if strict else "pass", len(chunk), size, res.seconds, len(chunk) - len(bad),
                 len(bad), sum(ratios) / max(1, len(ratios)))
        if keep_replies:
            replies.append({"pass": "retry" if strict else "first", "model": res.model,
                            "seconds": round(res.seconds, 2), "sent": sent,
                            "reply": res.content, "aligned": [round(r, 3) for r in ratios]})
        return bad

    failures = 0
    try:
        for chunk in _batches(parts, todo, BATCH):
            try:
                bad = await ask(chunk, False)
            except LLMError as e:
                # nothing came back yet: the LLM is away, and the caller says so
                if not done:
                    raise
                failures += 1
                log.warning("aerab batch skipped (%d units): %s", len(chunk), e)
                if failures >= 2:
                    break
                continue
            failures = 0
            refused |= bad
            done |= set(chunk)
            if progress:
                progress(sum(len(before[i]) for i in done) / total)
    except _OutOfTime:
        log.info("aerab ran out of its %.0f s budget with %d of %d units done", budget, len(done), len(todo))
    try:
        for chunk in _batches(parts, _weak(parts, sorted(done), lang), RETRY_BATCH):
            again = await ask(chunk, True)
            refused = (refused - set(chunk)) | (again & refused)
    except _OutOfTime:
        pass
    except LLMError as e:
        log.warning("aerab retry skipped: %s", e)
    remaining = sum(len(before[i]) for i in wanted if i not in done)
    out = "".join(parts)
    return Result(out, sum(parts[i] != before[i] for i in done), len(refused), len(_weak(parts, done, lang)), lang,
                  complete=remaining == 0, remaining_chars=remaining, coverage=coverage(out), replies=tuple(replies))


async def mark(text: str, language: str | None = None, budget: float | None = None, debug: bool = False) -> Result:
    """Aerab for every Arabic-script line of `text` (lyrics, a script, a book). Raises LLMError when the LLM
    is away; the strict retry of sparse lines is best effort. With `budget` (seconds) it stops starting new
    calls when time runs out and says what is left (`complete`, `remaining_chars`)."""
    return await _run(text, language, budget, keep_replies=debug)


def mark_sync(text: str, language: str | None = None, tick=None, progress=None) -> Result:
    from app.llm.client import _with_ticks

    return asyncio.run(_with_ticks(_run(text, language, progress=progress), tick, 4.0))


# ---------------------------------------------------------------- the second pass after an AI writer

async def finish(text: str, language: str | None = None, what: str = "text") -> Result:
    """Verified marks on what an LLM just wrote. Never fails: with the LLM away the text stays as written."""
    if not applies(language, text):
        return Result(text)
    from app.llm import LLMError

    try:
        return await mark(text, target(language, text))
    except LLMError as e:
        log.warning("aerab pass skipped for the %s: %s", what, e)
        return Result(text, language=target(language, text))


def finish_sync(text: str, language: str | None = None, tick=None, what: str = "text") -> Result:
    if not applies(language, text):
        return Result(text)
    from app.llm import LLMError

    try:
        return mark_sync(text, target(language, text), tick)
    except LLMError as e:
        log.warning("aerab pass skipped for the %s: %s", what, e)
        return Result(text, language=target(language, text))


def finish_lines_sync(texts: list[str], language: str | None = None, tick=None, what: str = "lines") -> list[str]:
    """`finish_sync` for separate one-line texts (dub segments, transcript lines, podcast turns) in one go."""
    flat = [" ".join((t or "").split("\n")) for t in texts]
    joined = "\n".join(flat)
    if not applies(language, joined):
        return list(texts)
    out = finish_sync(joined, language, tick, what).text.split("\n")
    return out if len(out) == len(texts) else list(texts)


# ---------------------------------------------------------------- the jobs route

JOB = "text_aerab"


def handle(ctx) -> dict:
    """POST /api/text/aerab/jobs: the same pass with no time budget, for whole books."""
    from app.llm import LLMError

    p = ctx.job.payload or {}
    ctx.progress(0.01, "Adding aerab")
    try:
        r = mark_sync(p.get("text") or "", p.get("language"), tick=lambda: ctx.progress(ctx.job.progress or 0.01),
                      progress=lambda f: ctx.progress(0.02 + 0.95 * f, "Adding aerab"))
    except LLMError as e:
        log.warning("aerab job %s: %s", ctx.job.id, e)
        raise RuntimeError("The aerab writer is offline") from None
    ctx.progress(1.0, "Done")
    return r.out()


# ---------------------------------------------------------------- quoted dialogue in video prompts

# spoken lines in a video prompt: LTX-2.3 voices what is in quotes
_QUOTED = re.compile('"([^"\n]+)"|“([^”\n]+)”|«([^»\n]+)»')


def quoted_spoken(prompt: str) -> list[str]:
    on = enabled_languages()
    return [q for m in _QUOTED.finditer(prompt or "") for q in m.groups()
            if q and unmarked(q) and detect_language(q) in on]


def mark_quotes_many_sync(prompts: list[str], tick=None) -> list[str]:
    """Each prompt with its quoted Arabic-script lines marked; one LLM pass per language for the lot."""
    by_lang: dict[str, list[tuple[int, str]]] = {}
    for k, p in enumerate(prompts):
        for q in quoted_spoken(p):
            by_lang.setdefault(detect_language(q) or "ur", []).append((k, q))
    out = list(prompts)
    for lang, items in by_lang.items():
        done = mark_sync("\n".join(q for _, q in items), lang, tick).text.split("\n")
        for (k, old), new in zip(items, done):
            out[k] = out[k].replace(old, new, 1)
    return out


def mark_quotes_sync(prompt: str, tick=None) -> str:
    return mark_quotes_many_sync([prompt], tick)[0]
