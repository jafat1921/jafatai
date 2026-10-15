"""Keeping the copywriter honest (contract v36): offers only from the approved list, no invented numbers,
no invented ways to reach the brand.

The LLM is asked to copy offers verbatim and to write no numbers of its own; this is the check after it.
An offer line that isn't one of the approved ones is dropped. Any number or percentage in the kicker,
headline, body or CTA that doesn't appear in the approved offers (or in the brief's own must-say line, the
subject's name and description, the kit's phone numbers) goes, together with the currency or unit stuck to it.
Handles, web addresses and emails that aren't the kit's go too, and so does a platform the kit has no account
on: "Boka via WhatsApp" loses "via WhatsApp" when there's no WhatsApp number.
"""
import re
import unicodedata
from dataclasses import dataclass, field

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


# ---------------------------------------------------------------- channels

# the platform names copy might mention; X and Threads are ordinary words too often to police
PLATFORM_WORDS = {"instagram": "Instagram", "facebook": "Facebook", "tiktok": "TikTok", "linkedin": "LinkedIn",
                  "youtube": "YouTube", "pinterest": "Pinterest", "snapchat": "Snapchat", "whatsapp": "WhatsApp"}
# the little words that tie a channel to its verb: via WhatsApp, på Instagram, on TikTok, auf Facebook
_TIE = r"(?:via|on|at|through|in|på|i|hos|auf|über|bei|sur|en|op|su|na|w|em|por|ile|kautta|par)"
_TLDS = ("com", "se", "net", "org", "io", "co", "uk", "de", "no", "dk", "fi", "nl", "fr", "es", "it", "pk", "in",
         "ae", "sa", "app", "shop", "store", "online", "site", "info", "biz", "eu", "nu", "me", "tv", "ai", "pl",
         "pt", "tr", "at", "ch", "be", "us", "ca", "au")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_URL = re.compile(r"(?<![\w@.])(?:https?://)?(?:www\.)?((?:[a-z0-9-]+\.)+(?:%s))\b(?:/[^\s,;!?]*)?" % "|".join(_TLDS),
                  re.I)
_HANDLE = re.compile(r"(?<![\w@])@([\w.]*\w)")
_DANGLING = re.compile(r"\s+(?:och|and|or|eller|und|oder|et|ou|y|o|e|of|og|ja|tai|ve|veya|lub)$", re.I)


def _host(v: str) -> str:
    v = re.sub(r"^https?://", "", (v or "").strip().lower())
    return v.split("/")[0].removeprefix("www.")


@dataclass
class Channels:
    """What the kit really has, so the copy may name it."""
    platforms: set[str] = field(default_factory=set)
    handles: set[str] = field(default_factory=set)
    hosts: set[str] = field(default_factory=set)
    emails: set[str] = field(default_factory=set)
    numbers: set[str] = field(default_factory=set)

    def host_ok(self, host: str) -> bool:
        host = host.lower().removeprefix("www.")
        return any(host == h or host.endswith("." + h) for h in self.hosts)


def channels_of(contact: dict | None, socials: list[dict] | None) -> Channels:
    contact, ch = contact or {}, Channels()
    for s in socials or []:
        ch.platforms.add(s.get("platform") or "")
        ch.handles.add((s.get("handle") or "").lstrip("@+").lower())
        if s.get("url"):
            ch.hosts.add(_host(s["url"]))
    for k in ("website", "booking_url"):
        if contact.get(k):
            ch.hosts.add(_host(contact[k]))
    if contact.get("email"):
        ch.emails.add(contact["email"].strip().lower())
    if contact.get("whatsapp"):
        ch.platforms.add("whatsapp")
    for k in ("phone", "whatsapp"):
        d = re.sub(r"\D", "", contact.get(k) or "")
        if len(d) >= 6:
            # +46 72 846 73 94 is written 072-846 73 94 at home
            ch.numbers |= {d, d[-9:], "0" + d[-9:]}
    ch.platforms.discard("")
    ch.handles.discard("")
    return ch


def strip_channels(text: str, ch: Channels) -> tuple[str, list[str]]:
    """The text without handles, links, emails or platforms the kit doesn't have."""
    removed: list[str] = []

    def drop(m: re.Match, ok: bool) -> str:
        if ok:
            return m.group(0)
        removed.append(m.group(0).strip())
        return " "

    out = _EMAIL.sub(lambda m: drop(m, m.group(0).lower() in ch.emails), text or "")
    out = _URL.sub(lambda m: drop(m, ch.host_ok(m.group(1))), out)
    out = _HANDLE.sub(lambda m: drop(m, m.group(1).lower() in ch.handles), out)
    for key, word in PLATFORM_WORDS.items():
        if key not in ch.platforms:
            out = re.sub(rf"(?:\s+{_TIE})?\s*\b{word}\b", lambda m: drop(m, False), out, flags=re.I)
    out = "\n".join(re.sub(r"\s+([.,!?;:])", r"\1", re.sub(r"[ \t]{2,}", " ", ln)).strip(" ,;:-–")
                    for ln in out.split("\n"))
    if removed:
        # "Följ @ixperts och @fake" shouldn't end on its "och"
        out = "\n".join(_DANGLING.sub("", ln) for ln in out.split("\n"))
    return "\n".join(ln for ln in out.split("\n") if ln.strip(" .,-–·")), removed


# ---------------------------------------------------------------- punctuation

_QUESTION = "?؟"


def tidy(field: str, text: str) -> str:
    """Punctuation the way a designer sets it: a kicker carries no full stop (it's set in capitals as a label),
    a question ends on its question mark, and doubled or stray marks go ("Flyttar du?." -> "Flyttar du?")."""
    lines = []
    for ln in (text or "").split("\n"):
        ln = " ".join(ln.split())
        ln = re.sub(r"\s+([.,!?;:؟،])", r"\1", ln)
        ln = re.sub(r"([?؟!])[.。]+", r"\1", ln)
        ln = re.sub(r"(?<!\.)\.\.(?!\.)", ".", ln)  # ".." is a typo; "..." is meant
        ln = re.sub(r"([!?؟])\1+", r"\1", ln)
        ln = re.sub(r",\s*([.!?؟])", r"\1", ln)
        lines.append(ln)
    out = "\n".join(lines).strip()
    if field == "kicker":
        out = re.sub(r"(?<!\.)\.$", "", out).rstrip()
    elif field == "headline" and out.rstrip(".").endswith(tuple(_QUESTION)):
        out = out.rstrip(".")
    return out


def guard(concept: dict, approved: list[str], extra_text: str = "",
          channels: Channels | None = None) -> tuple[dict, dict]:
    """(the concept with only approved offers, numbers and channels, what was taken out)."""
    c = dict(concept)
    ch = channels or Channels()
    report = {"offers_dropped": [], "numbers_removed": [], "channels_removed": []}
    kept: list[str] = []
    for o in c.get("offers") or []:
        a = match_offer(o, approved)
        if a and a not in kept:
            kept.append(a)
        elif not a:
            report["offers_dropped"].append(o)
    c["offers"] = kept[:2]
    allowed = set().union(*(numbers(a) for a in approved), numbers(extra_text)) if (approved or extra_text) else set()
    allowed |= ch.numbers
    for k in TEXT_FIELDS:
        text, gone = strip_channels(c.get(k) or "", ch)
        report["channels_removed"] += gone
        text, gone = strip_numbers(text, allowed)
        c[k] = tidy(k, text)
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
