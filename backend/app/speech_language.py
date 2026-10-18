"""Which language a piece of speech is really in.

The engines are told one language per call and believe it. Urdu letters sent as "en" (the Speak page's
default), or an English line sent as "ur" because the voice picked is an Urdu one, come out as neither
language. So the letters decide whenever they contradict the request, or there is no request; a request the
letters agree with always stands ("ar" for Arabic letters stays Arabic, "ur-latn" for Latin stays Roman Urdu).
"""
import re
import unicodedata

from app import aerab

# the script each language is written in; a language missing here is never second-guessed
_SCRIPTS = {
    "arabic": {"ur", "ar", "fa", "ps", "sd", "pnb", "ks", "bal", "skr", "ku", "ckb", "ug"},
    "devanagari": {"hi", "mr", "ne", "sa", "mai", "bho"},
    "gurmukhi": {"pa"},
    "bengali": {"bn", "as"},
    "han": {"zh", "yue", "ja"},
    "kana": {"ja"},
    "hangul": {"ko"},
    "cyrillic": {"ru", "uk", "bg", "sr", "kk", "tg", "mn", "be", "mk"},
    "greek": {"el"},
    "hebrew": {"he", "yi"},
    "thai": {"th"},
    "latin": {"en", "es", "fr", "de", "pt", "it", "id", "ms", "sw", "tr", "pl", "nl", "sv", "da", "no", "fi", "cs",
              "ro", "hu", "sk", "hr", "az", "uz", "tl", "vi", "ha", "yo", "ig", "zu", "so"},
}
# what letters of a script are read as when the request is in another script
_DEFAULT = {"devanagari": "hi", "gurmukhi": "pa", "bengali": "bn", "han": "zh", "kana": "ja", "hangul": "ko",
            "cyrillic": "ru", "greek": "el", "hebrew": "he", "thai": "th", "latin": "en"}
_UNSURE = {"", "auto", "und", "mul", "unknown"}
# Roman Urdu / Hindi: common words that English never uses, to keep "ur" on Latin letters
_ROMAN = {"hai", "hain", "nahi", "nahin", "kya", "kyun", "mein", "main", "aap", "tum", "hum", "ka", "ki", "ke",
          "ko", "se", "ne", "tha", "thi", "aur", "yeh", "ye", "woh", "wo", "kar", "karo", "raha", "rahi", "gaya",
          "bhi", "ho", "kaise", "acha", "accha", "theek", "bohat", "bahut", "jee", "ji", "mera", "meri", "tera"}
_ENGLISH = {"the", "and", "is", "are", "was", "you", "to", "of", "it", "this", "that", "with", "for", "my", "your",
            "what", "have", "not", "be", "we", "they", "will", "can", "a", "an", "in", "on"}
_PERSIAN = {"است", "را", "که", "این", "آن", "می", "از", "هست", "نیست", "بود", "برای", "هم", "شد", "من", "ما", "شما"}
_SOUTH_ASIAN = {"ur", "pnb", "pa", "hi", "sd", "skr"}
# a sentence ends at these (Urdu's full stop and question mark too); the next one may change language
_SENTENCE = re.compile(r"(?<=[.!?۔؟])\s+")
_TAG = re.compile(r"\[[^\]]*\]")


def code(language: str | None) -> str | None:
    c = (language or "").strip().lower().replace("_", "-")
    return None if c in _UNSURE else c


def script_of(language: str | None) -> str | None:
    c = code(language)
    if c is None:
        return None
    if "latn" in c:
        return "latin"
    base = {"pa-arab": "pnb", "pa-pk": "pnb"}.get(c, c).split("-")[0]
    return next((s for s, langs in _SCRIPTS.items() if base in langs), None)


def _char_script(ch: str) -> str | None:
    if not unicodedata.category(ch).startswith("L"):
        return None
    o = ord(ch)
    if 0x0600 <= o <= 0x06FF or 0x0750 <= o <= 0x077F or 0x08A0 <= o <= 0x08FF or 0xFB50 <= o <= 0xFEFF:
        return "arabic"
    if 0x0900 <= o <= 0x097F:
        return "devanagari"
    if 0x0980 <= o <= 0x09FF:
        return "bengali"
    if 0x0A00 <= o <= 0x0A7F:
        return "gurmukhi"
    if 0x3040 <= o <= 0x30FF:
        return "kana"
    if 0x3400 <= o <= 0x9FFF:
        return "han"
    if 0xAC00 <= o <= 0xD7AF or 0x1100 <= o <= 0x11FF or 0x3130 <= o <= 0x318F:
        return "hangul"
    if 0x0400 <= o <= 0x052F:
        return "cyrillic"
    if 0x0370 <= o <= 0x03FF:
        return "greek"
    if 0x0590 <= o <= 0x05FF:
        return "hebrew"
    if 0x0E00 <= o <= 0x0E7F:
        return "thai"
    if o < 0x0250 or 0x1E00 <= o <= 0x1EFF:
        return "latin"
    return "other"


def letters_by_script(text: str) -> dict[str, int]:
    out: dict[str, int] = {}
    # [laughter], [pause 1s]: English words, but never spoken as such
    for ch in _TAG.sub(" ", text or ""):
        s = _char_script(ch)
        if s:
            out[s] = out.get(s, 0) + 1
    return out


def _roman(text: str) -> bool:
    words = re.findall(r"[a-z]+", _TAG.sub(" ", text or "").lower())
    roman = sum(w in _ROMAN for w in words)
    return roman > 0 and roman >= sum(w in _ENGLISH for w in words)


def _arabic(text: str) -> str:
    found = aerab.detect_language(text) or "ur"
    # one ک or گ makes aerab guess Persian; a short Urdu line ("آج کل") has nothing else to go on, and Urdu
    # read as Persian is exactly the "other language" people heard. Persian has to show its own words.
    if found == "fa" and not set(re.findall(r"\S+", aerab.strip(text))) & _PERSIAN:
        return "ur"
    return found


def language_of(text: str, requested: str | None = None, fallback: str | None = None) -> str:
    """The language to speak `text` in: `requested` unless the letters say otherwise. `fallback` (a voice's
    own language) is the next guess for letters the request doesn't fit."""
    req, fb = code(requested), code(fallback)
    counts = letters_by_script(text)
    if not counts:
        return req or fb or "en"
    script = max(counts, key=counts.get)
    if script == "han" and counts.get("kana"):
        script = "kana"  # Japanese mixes kanji in; any kana at all means Japanese
    if req and script_of(req) in (script, None):
        return req
    if script == "other":
        return req or fb or "en"
    if fb and script_of(fb) == script:
        return fb
    if script == "arabic":
        return "pnb" if req == "pa" else _arabic(text)
    if script == "latin" and req in _SOUTH_ASIAN and _roman(text):
        return req  # Roman Urdu typed with Urdu chosen: still Urdu, in Latin letters
    if script == "latin" and fb in _SOUTH_ASIAN and not req and _roman(text):
        return fb
    return _DEFAULT[script]


def runs(text: str, requested: str | None = None, fallback: str | None = None) -> list[tuple[str, str]]:
    """`text` cut at sentence ends where the language changes: [(piece, language), ...]. Within a sentence the
    larger script wins; an English word inside an Urdu sentence is read the way Urdu speakers say it anyway."""
    out: list[tuple[str, str]] = []
    for sentence in _SENTENCE.split(" ".join((text or "").split())):
        if not sentence:
            continue
        if out and not letters_by_script(sentence):
            out[-1] = (f"{out[-1][0]} {sentence}", out[-1][1])  # a stray "..." stays with what it follows
            continue
        lang = language_of(sentence, requested, fallback)
        if out and out[-1][1] == lang:
            out[-1] = (f"{out[-1][0]} {sentence}", lang)
        else:
            out.append((sentence, lang))
    return out


def dominant(text: str, requested: str | None = None, fallback: str | None = None) -> str:
    """The language most of `text` is in (by letters), for the one language a whole take is filed under."""
    totals: dict[str, int] = {}
    for piece, lang in runs(text, requested, fallback):
        totals[lang] = totals.get(lang, 0) + sum(letters_by_script(piece).values())
    if not totals:
        return code(requested) or code(fallback) or "en"
    return max(totals, key=totals.get)
