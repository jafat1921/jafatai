"""Keeping the copywriter honest (contract v36): offers only from the approved list, no invented numbers.

The LLM is asked to copy offers verbatim and to write no numbers of its own; this is the check after it.
An offer line that isn't one of the approved ones is dropped. Any number or percentage in the kicker,
headline, body or CTA that doesn't appear in the approved offers (or in the brief's own must-say line, the
subject's name and description) goes, together with the currency or unit stuck to it.
"""
import re
import unicodedata

TEXT_FIELDS = ("kicker", "headline", "body", "cta")
# a number as copy writes it: 215, 1 500, 1.500,50, 15%, 15 %, ٪۱۵
_NUM = re.compile(r"[%٪]?\s?\d(?:[\d   .,:/-]*\d)?\s?[%٪]?")
_UNIT = r"(?:kr|sek|nok|dkk|eur|usd|gbp|pkr|inr|aed|sar|rs\.?|€|\$|£|₹|:-|/\s?\w+)"


def _ascii_digits(s: str) -> str:
    return "".join(str(unicodedata.digit(ch)) if ch.isdigit() else ch for ch in s)


def numbers(text: str) -> set[str]:
    """The numbers in text, normalised: digits only, Arabic-Indic digits folded, a trailing % kept."""
    out = set()
    for m in _NUM.finditer(text or ""):
        raw = _ascii_digits(m.group(0))
        digits = re.sub(r"\D", "", raw)
        if not digits:
            continue
        out.add(digits + ("%" if re.search(r"[%٪]", m.group(0)) else ""))
        out.add(digits)
    return out


def _norm(s: str) -> str:
    return " ".join(_ascii_digits(s or "").casefold().split()).strip(" .!")


def match_offer(line: str, approved: list[str]) -> str | None:
    """The approved offer this line is, written the approved way; None when it isn't one."""
    n = _norm(line)
    if not n:
        return None
    for a in approved:
        if _norm(a) == n:
            return a
    # a writer trimming punctuation or adding a word around an approved line still counts as that line
    for a in approved:
        na = _norm(a)
        if na and (na in n or n in na) and numbers(n) <= numbers(na):
            return a
    return None


def strip_numbers(text: str, allowed: set[str]) -> tuple[str, list[str]]:
    removed: list[str] = []

    def drop(m: re.Match) -> str:
        raw = m.group(0)
        got = numbers(raw)
        if got and not (got & allowed):
            removed.append(raw.strip())
            return " "
        return raw

    pat = re.compile(rf"(?:{_UNIT}\s?)?{_NUM.pattern}(?:\s?{_UNIT})?", re.I)
    out = pat.sub(drop, text or "")
    # tidy what the cut left: doubled spaces, a space before punctuation, an empty line
    out = "\n".join(re.sub(r"\s+([.,!?;:])", r"\1", re.sub(r"[ \t]{2,}", " ", ln)).strip()
                    for ln in out.split("\n"))
    return "\n".join(ln for ln in out.split("\n") if ln.strip(" .,-–·")), removed


def guard(concept: dict, approved: list[str], extra_text: str = "") -> tuple[dict, dict]:
    """(the concept with only approved offers and numbers, what was taken out)."""
    c = dict(concept)
    report = {"offers_dropped": [], "numbers_removed": []}
    kept: list[str] = []
    for o in c.get("offers") or []:
        a = match_offer(o, approved)
        if a and a not in kept:
            kept.append(a)
        elif not a:
            report["offers_dropped"].append(o)
    c["offers"] = kept[:2]
    allowed = set().union(*(numbers(a) for a in approved), numbers(extra_text)) if (approved or extra_text) else set()
    for k in TEXT_FIELDS:
        text, gone = strip_numbers(c.get(k) or "", allowed)
        c[k] = text
        report["numbers_removed"] += gone
    if not c.get("headline", "").strip():
        # nothing left of the headline: the kicker moves up rather than leaving an empty ad
        c["headline"], c["kicker"] = c.get("kicker") or c.get("cta") or "", ""
    return c, report


_BIG = re.compile(rf"(?:{_UNIT}\s?)?\d[\d  .,]*\s?(?:[%٪]|{_UNIT})?", re.I)


def badge_from(offers: list[str]) -> tuple[str, str]:
    """(big, small) for the price badge from the first offer with a number: "15%" over "RABATT"."""
    for o in offers or []:
        m = _BIG.search(o)
        if not m:
            continue
        big = " ".join(m.group(0).split())
        rest = (o[:m.start()] + " " + o[m.end():]).split()
        # one word under the number: the first real word left over ("RABATT", "FRÅN"); editable later
        small = next((w.strip(".,!") for w in rest if len(w) > 2 and not w.startswith("/")), "")[:14]
        return big[:10], small.upper() if not re.search(r"[؀-ۿ]", small) else small
    return "", ""
