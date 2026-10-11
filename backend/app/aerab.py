"""Aerab / tashkeel for the Arabic-script languages (contract v23): Urdu, Arabic, Persian, Pashto, Sindhi and
Punjabi in Shahmukhi. Without the short vowels the TTS, song and video models guess, and guess wrong.

The LLM only proposes the marks. They are then moved onto the writer's own letters, and a line whose
letters the LLM changed (a "corrected" spelling, a swapped word) is left exactly as it was written.
"""
import logging
import re
import unicodedata
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

# Code points an LLM likes to swap in for the ones each language uses. Only the safety check folds them:
# the writer's own letters are what ends up in the text, so Arabic keeps ي ى ك ة and Urdu keeps ی ک ہ.
_URDU_FOLD = {"ي": "ی", "ى": "ی", "ك": "ک", "ه": "ہ", "ە": "ہ", "ة": "ۃ"}
_FOLDS = {
    "ur": _URDU_FOLD,
    "pnb": _URDU_FOLD,
    "fa": {"ي": "ی", "ى": "ی", "ك": "ک", "ہ": "ه", "ە": "ه", "ۃ": "ة"},
    # Pashto writes ي and ی as two different letters, so they never fold
    "ps": {"ى": "ی", "ك": "ک", "ہ": "ه", "ە": "ه", "ۃ": "ة"},
    # Sindhi's ye is ي and its k is ڪ (ک is kh)
    "sd": {"ی": "ي", "ى": "ي", "ك": "ڪ", "ہ": "ه", "ە": "ه"},
    # vocalising MSA, models like to add or drop a hamza seat or write the wasla; the writer's alif stands
    "ar": {"ی": "ي", "ک": "ك", "ہ": "ه", "ە": "ه", "ۃ": "ة", "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا"},
}
_FOLD_TABLES = {k: str.maketrans(v) for k, v in _FOLDS.items()}

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
BATCH = 40
RETRY_BATCH = 10
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


def messages(lines: list[str], language: str | None = None, strict: bool = False) -> list[dict]:
    lang = language if language in _RULES else "ur"
    name, (what, marks, letters) = NAMES[lang], _RULES[lang]
    rules = [
        f"You add {what} to {name} lines that will be spoken or sung, so every word is pronounced correctly.",
        f"For each line, return the same line with full marks: {marks}.",
        "Mark the vowel of every letter whose sound is not obvious from the spelling."
        + (" Arabic is vocalised in full: every letter gets its mark." if lang == "ar"
           else " Long vowels written with alif, wao or ye need no extra mark."),
        f"Never add, remove, replace or reorder a letter or a word. Do not correct spelling, do not translate, "
        f"{letters}, keep the spaces.",
        f"Lines that are not {name} come back unchanged.",
        'Reply as JSON: {"lines": [the lines in the same order, one string per line]}. Same number of lines.',
    ]
    if strict:
        rules.insert(2, "An earlier pass left most words of these lines bare. Mark EVERY word this time.")
    user = "\n".join(f"{i + 1}. {line}" for i, line in enumerate(lines))
    return [{"role": "system", "content": "\n".join(rules)}, {"role": "user", "content": user}]


# ---------------------------------------------------------------- putting marks back

def _clusters(text: str) -> list[tuple[str, str]]:
    """(letter, marks after it) for every letter; spaces and joiners are dropped."""
    out: list[tuple[str, str]] = []
    for ch in unicodedata.normalize("NFC", text):
        if is_mark(ch):
            if out:
                out[-1] = (out[-1][0], out[-1][1] + ch)
        elif not ch.isspace() and ch not in _SOFT:
            out.append((ch, ""))
    return out


def transfer(original: str, marked: str, language: str | None = None) -> str | None:
    """`original` with the marks from `marked`, or None when the two don't spell the same letters."""
    fold = _FOLD_TABLES.get(language or "ur", _FOLD_TABLES["ur"])
    src = _clusters(original)
    got = _clusters(marked)
    if len(src) != len(got) or any(a.translate(fold) != b.translate(fold) for (a, _), (b, _) in zip(src, got)):
        return None
    out, i = [], 0
    text = unicodedata.normalize("NFC", original)
    for ch in text:
        if is_mark(ch):
            continue
        out.append(ch)
        if ch.isspace() or ch in _SOFT:
            continue
        # marks the writer typed win over the LLM's
        own = src[i][1]
        out.append(own or got[i][1])
        i += 1
    return "".join(out)


def _unnumber(line: str, n: int) -> str:
    return re.sub(rf"^\s*{n}\s*[.)\-:]\s*", "", line)


def _apply(rows: list[str], idx: list[int], proposed: list[str], language: str | None) -> set[int]:
    """Marks the rows at `idx` in place from `proposed`; returns the rows whose letters didn't match."""
    refused = set()
    for k, i in enumerate(idx):
        got = transfer(rows[i], _unnumber(proposed[k], k + 1), language) if k < len(proposed) else None
        if got is None:
            refused.add(i)
        else:
            rows[i] = got
    return refused


def merge(text: str, proposed: list[str], language: str | None = None) -> tuple[str, int, int]:
    """Put the proposed lines back into `text`: (new text, lines marked, lines kept as written)."""
    rows = text.split("\n")
    before = list(rows)
    todo = [i for i, row in enumerate(rows) if needs_marks(row)]
    refused = _apply(rows, todo, proposed, language)
    return "\n".join(rows), sum(rows[i] != before[i] for i in todo), len(refused)


def lines_to_mark(text: str) -> list[str]:
    return [row for row in text.split("\n") if needs_marks(row)][:MAX_LINES]


class Result(NamedTuple):
    text: str
    marked: int = 0
    kept: int = 0
    low_coverage: int = 0
    language: str | None = None

    def stats(self) -> dict:
        return {"marked": self.marked, "kept": self.kept, "low_coverage": self.low_coverage}


ASK = dict(schema=Marked, think=False, temperature=0.2, max_tokens=4000, timeout=180.0)


def _plan(text: str, language: str | None) -> tuple[str, list[str], list[int]]:
    lang = resolve(language, text) or detect_language(text) or "ur"
    rows = text.split("\n")
    return lang, rows, [i for i, row in enumerate(rows) if needs_marks(row)][:MAX_LINES]


def _chunks(idx: list[int], size: int) -> list[list[int]]:
    return [idx[b:b + size] for b in range(0, len(idx), size)]


def _weak(rows: list[str], idx: list[int], lang: str) -> list[int]:
    return [i for i in idx if coverage(rows[i]) < min_coverage(lang)]


def _result(rows, before, todo, refused, lang) -> Result:
    return Result("\n".join(rows), sum(rows[i] != before[i] for i in todo), len(refused),
                  len(_weak(rows, todo, lang)), lang)


async def mark(text: str, language: str | None = None) -> Result:
    """Aerab for every Arabic-script line of `text` (lyrics, a script). Raises LLMError when the LLM is away;
    the strict retry of sparse lines is best effort."""
    from app.llm import LLMError, chat

    lang, rows, todo = _plan(text, language)
    if not todo:
        return Result(text, language=lang)
    before = list(rows)
    refused: set[int] = set()
    for chunk in _chunks(todo, BATCH):
        res = await chat("creative", messages([rows[i] for i in chunk], lang), **ASK)
        refused |= _apply(rows, chunk, res.data.lines, lang)
    try:
        for chunk in _chunks(_weak(rows, todo, lang), RETRY_BATCH):
            res = await chat("creative", messages([rows[i] for i in chunk], lang, strict=True), **ASK)
            again = _apply(rows, chunk, res.data.lines, lang)
            refused = (refused - set(chunk)) | (again & refused)
    except LLMError as e:
        log.warning("aerab retry skipped: %s", e)
    return _result(rows, before, todo, refused, lang)


def mark_sync(text: str, language: str | None = None, tick=None) -> Result:
    from app.llm import LLMError, chat_sync

    lang, rows, todo = _plan(text, language)
    if not todo:
        return Result(text, language=lang)
    before = list(rows)
    refused: set[int] = set()
    for chunk in _chunks(todo, BATCH):
        res = chat_sync("creative", messages([rows[i] for i in chunk], lang), tick=tick, **ASK)
        refused |= _apply(rows, chunk, res.data.lines, lang)
    try:
        for chunk in _chunks(_weak(rows, todo, lang), RETRY_BATCH):
            res = chat_sync("creative", messages([rows[i] for i in chunk], lang, strict=True), tick=tick, **ASK)
            again = _apply(rows, chunk, res.data.lines, lang)
            refused = (refused - set(chunk)) | (again & refused)
    except LLMError as e:
        log.warning("aerab retry skipped: %s", e)
    return _result(rows, before, todo, refused, lang)


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
