"""Aerab (zer, zabar, pesh, jazm, tashdeed...) for Urdu lyrics, so the song models stop guessing vowels.

The LLM only proposes the marks. They are then moved onto the writer's own letters, and a line whose
letters the LLM changed (a "corrected" spelling, a swapped word) is left exactly as it was written.
"""
import re
import unicodedata

from pydantic import BaseModel

# harakat and the small Quranic-style signs; hamza above / below (0654, 0655) are spelling, not marks
_MARKS = re.compile("[ؐ-ًؚ-ٖٓ-ٰٟۖ-ۜ۟-۪ۨ-ۭ]")
# invisible joiners and the tatweel: allowed to come and go, never compared
_SOFT = "‌‍ـ"
# Arabic code points an LLM likes to swap in for the Urdu ones
_FOLD = str.maketrans({"ي": "ی", "ى": "ی", "ك": "ک", "ه": "ہ", "ە": "ہ",
                       "ة": "ۃ"})
_ARABIC_SCRIPT = re.compile("[؀-ۿ]")
_MARKER = re.compile(r"^\s*\[[^\]]+\]\s*$")

MAX_LINES = 160


def is_mark(ch: str) -> bool:
    return bool(_MARKS.fullmatch(ch))


def strip(text: str) -> str:
    return _MARKS.sub("", text)


def needs_marks(line: str) -> bool:
    return bool(_ARABIC_SCRIPT.search(line)) and not _MARKER.match(line)


def unmarked(line: str) -> bool:
    """Urdu with (almost) no aerab yet; a line the writer marked themselves is theirs."""
    if not needs_marks(line):
        return False
    letters = sum(1 for ch in line if _ARABIC_SCRIPT.match(ch) and not is_mark(ch))
    return sum(1 for ch in line if is_mark(ch)) * 6 < letters


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


def transfer(original: str, marked: str) -> str | None:
    """`original` with the marks from `marked`, or None when the two don't spell the same letters."""
    src = _clusters(original)
    got = _clusters(marked)
    if len(src) != len(got) or any(a.translate(_FOLD) != b.translate(_FOLD) for (a, _), (b, _) in zip(src, got)):
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


class Marked(BaseModel):
    lines: list[str]


def messages(lines: list[str]) -> list[dict]:
    rules = [
        "You add aerab (Urdu diacritics, harakat) to Urdu song lyrics so a singer pronounces every word correctly.",
        "For each line, return the same line with full aerab: zabar (َ), zer (ِ), pesh (ُ), jazm (ْ) on "
        "silent letters, tashdeed (ّ) on doubled letters, tanween (ً) where Urdu uses it (fauran فوراً), "
        "khari zabar (ٰ) where it is read, and the izafat zer between joined words (dil-e-nadan "
        "دِلِ ناداں).",
        "Mark the vowel of every letter whose sound is not obvious from the spelling; long vowels written with "
        "alif, wao or ye need no extra mark.",
        "Never add, remove, replace or reorder a letter or a word. Do not correct spelling, do not translate, keep "
        "the Urdu letters (ی ک ہ ے ں) as they are, keep the spaces.",
        "Lines that are not Urdu come back unchanged.",
        'Reply as JSON: {"lines": [the lines in the same order, one string per line]}. Same number of lines.',
    ]
    user = "\n".join(f"{i + 1}. {line}" for i, line in enumerate(lines))
    return [{"role": "system", "content": "\n".join(rules)}, {"role": "user", "content": user}]


def _unnumber(line: str, n: int) -> str:
    return re.sub(rf"^\s*{n}\s*[.)\-:]\s*", "", line)


def merge(text: str, proposed: list[str]) -> tuple[str, int, int]:
    """Put the proposed lines back into `text`: (new text, lines marked, lines kept as written)."""
    rows = text.split("\n")
    todo = [i for i, row in enumerate(rows) if needs_marks(row)]
    marked = kept = 0
    for k, i in enumerate(todo):
        got = transfer(rows[i], _unnumber(proposed[k], k + 1)) if k < len(proposed) else None
        if got is None:
            kept += 1
        else:
            marked += got != rows[i]
            rows[i] = got
    return "\n".join(rows), marked, kept


def lines_to_mark(text: str) -> list[str]:
    return [row for row in text.split("\n") if needs_marks(row)][:MAX_LINES]


ASK = dict(schema=Marked, think=False, temperature=0.2, max_tokens=4000, timeout=180.0)


async def mark(text: str) -> tuple[str, int, int]:
    """Aerab for every Urdu line of `text` (lyrics, a script). Raises LLMError when the LLM is away."""
    from app.llm import chat

    lines = lines_to_mark(text)
    if not lines:
        return text, 0, 0
    res = await chat("creative", messages(lines), **ASK)
    return merge(text, res.data.lines)


def mark_sync(text: str, tick=None) -> tuple[str, int, int]:
    from app.llm import chat_sync

    lines = lines_to_mark(text)
    if not lines:
        return text, 0, 0
    res = chat_sync("creative", messages(lines), tick=tick, **ASK)
    return merge(text, res.data.lines)


# spoken lines in a video prompt: LTX-2.3 voices what is in quotes
_QUOTED = re.compile('"([^"\n]+)"|“([^”\n]+)”|«([^»\n]+)»')


def quoted_urdu(prompt: str) -> list[str]:
    return [q for m in _QUOTED.finditer(prompt) for q in m.groups() if q and unmarked(q)]


def mark_quotes_sync(prompt: str, tick=None) -> str:
    spans = quoted_urdu(prompt)
    if not spans:
        return prompt
    done, _, _ = mark_sync("\n".join(spans), tick)
    out = prompt
    for old, new in zip(spans, done.split("\n")):
        out = out.replace(old, new, 1)
    return out
