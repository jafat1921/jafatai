"""OmniVoice's voice design only takes a fixed list of attributes; everything else makes it refuse the job.

People (and the gallery) describe voices freely: "warm elderly Lahori narrator, slow, deep". This turns
that into the attributes OmniVoice knows ("male, elderly, low pitch, indian accent"), keeps what it
can't say as a speed hint where there is one, and reports what was dropped so the UI can say so.
"""
import re
from dataclasses import dataclass, field

# OmniVoice 0.2.1's own list (its error message prints it)
VALID = ("american accent", "australian accent", "british accent", "canadian accent", "child", "chinese accent",
         "elderly", "female", "high pitch", "indian accent", "japanese accent", "korean accent", "low pitch",
         "male", "middle-aged", "moderate pitch", "portuguese accent", "russian accent", "teenager",
         "very high pitch", "very low pitch", "whisper", "young adult")

# (slot, phrase) -> attribute; longer phrases are tried first so "very deep" beats "deep"
_WORDS: dict[str, list[tuple[str, str]]] = {}


def _add(slot: str, value: str, *phrases: str) -> None:
    for p in phrases:
        _WORDS.setdefault(p, []).append((slot, value))


_add("gender", "male", "male", "man", "masculine", "gentleman", "father", "dada", "nana", "grandfather")
_add("gender", "female", "female", "woman", "feminine", "lady", "mother", "dadi", "nani", "grandmother")
_add("age", "child", "child", "kid", "kids", "little")
_add("gender", "male", "boy", "boys")
_add("gender", "female", "girl", "girls")
_add("age", "teenager", "teenager", "teen", "teenage", "adolescent")
_add("age", "young adult", "young adult", "young", "youthful", "student")
_add("age", "middle-aged", "middle-aged", "middle aged", "mature", "adult")
_add("age", "elderly", "elderly", "old", "elder", "aged", "senior", "grandfather", "grandmother", "dada", "dadi",
     "nana", "nani")
_add("pitch", "very low pitch", "very low pitch", "very low", "very deep", "booming")
_add("pitch", "low pitch", "low pitch", "low", "deep", "bass", "baritone", "husky", "gravelly")
_add("pitch", "moderate pitch", "moderate pitch", "moderate", "medium pitch", "mid pitch")
# "bright" is a colour of the voice, not its pitch: as high pitch it turned Urdu child voices into noise
_add("pitch", "high pitch", "high pitch", "high", "soprano", "light voice")
_add("pitch", "very high pitch", "very high pitch", "very high", "squeaky")
_add("whisper", "whisper", "whisper", "whispering", "whispered", "hushed")
for accent, *names in (
        ("american accent", "american", "us accent"), ("british accent", "british", "uk accent", "english accent", "rp"),
        ("australian accent", "australian"), ("canadian accent", "canadian"), ("chinese accent", "chinese", "mandarin"),
        ("japanese accent", "japanese"), ("korean accent", "korean"), ("russian accent", "russian"),
        ("portuguese accent", "portuguese", "brazilian"),
        # OmniVoice has no Pakistani or other South Asian accents; Indian is the closest it knows
        ("indian accent", "indian", "pakistani", "south asian", "desi", "urdu", "hindi", "punjabi", "sindhi",
         "bengali", "lahori", "karachi", "peshawari", "delhi", "mumbai")):
    _add("accent", accent, accent, *names)

SLOW = ("slow", "slowly", "measured", "unhurried", "calm", "leisurely", "gentle")
FAST = ("fast", "quick", "rapid", "brisk", "energetic", "excited")
SLOTS = ("gender", "age", "pitch", "accent", "whisper")
# words not worth reporting as dropped
FILLER = {"a", "an", "the", "voice", "voiced", "tone", "with", "speaker", "ji", "sahab", "sahib", "accent", "pitch"}
_PHRASES = sorted(_WORDS, key=len, reverse=True)
_CJK = re.compile(r"[一-鿿]")
# OmniVoice's high and very high pitch come out as noise in these languages (heard live: Whisper finds no
# words, the owner hears static); moderate pitch speaks the same line clearly
NO_HIGH_PITCH = {"ur", "pnb", "pa", "sd", "ps"}
_YEARS_OLD = re.compile(r"\b(\d{1,3})[\s-]*(?:years?|yrs?)[\s-]*old\b")


@dataclass
class Instruct:
    text: str | None
    understood: list[str] = field(default_factory=list)
    ignored: list[str] = field(default_factory=list)
    # 1.0 unless the description asked for a slow or fast delivery
    speed: float = 1.0


def normalise(description: str | None, language: str | None = None) -> Instruct:
    raw = " ".join((description or "").split())
    if not raw:
        return Instruct(None)
    if _CJK.search(raw):
        # Chinese instructs have their own list and OmniVoice checks them itself
        return Instruct(raw, understood=[raw])
    picked: dict[str, str] = {}
    ignored: list[str] = []
    speed = 1.0
    for part in re.split(r"[,;/|]+|\band\b", raw.lower()):
        part = part.strip(" .")
        if not part:
            continue
        rest = f" {part} "
        hit = False
        for p in _PHRASES:
            if f" {p} " in rest:
                # the first word for a slot wins: "young girl, elderly" shouldn't flip-flop
                for slot, value in _WORDS[p]:
                    picked.setdefault(slot, value)
                rest = rest.replace(f" {p} ", " ")
                hit = True
        words = rest.split()
        if set(words) & set(SLOW):
            speed, hit = 0.9, True
        elif set(words) & set(FAST):
            speed, hit = 1.08, True
        left = [w for w in words if w not in FILLER and w not in SLOW and w not in FAST]
        if not hit:
            ignored.append(part)
        elif left:
            ignored.append(" ".join(left))
    # "4-year-old boy" gives the age as a number
    m = _YEARS_OLD.search(raw.lower())
    if m and "age" not in picked:
        picked["age"] = _age_word(m[1])
    # a boy or girl with no other age word is a child
    if "age" not in picked and re.search(r"\b(boy|girl|kid)s?\b", raw.lower()):
        picked["age"] = "child"
    if (language or "").lower() in NO_HIGH_PITCH and picked.get("pitch") in ("high pitch", "very high pitch"):
        picked["pitch"] = "moderate pitch"
    items = [picked[s] for s in SLOTS if s in picked]
    return Instruct(", ".join(items) or None, understood=items, ignored=ignored, speed=speed)


def _age_word(age: str) -> str:
    # profiles say "34", "mid-30s" or "elderly"; OmniVoice knows five age bands
    m = re.search(r"\d+", age)
    if not m:
        return age
    n = int(m[0])
    return "child" if n < 13 else "teenager" if n < 20 else "young adult" if n < 36 else \
        "middle-aged" if n < 60 else "elderly"


def from_profile(profile: dict | None, extra: str = "") -> tuple[str, Instruct]:
    """A character's voice (contract v26): gender, age and accent from the Character Studio profile, plus
    anything the user adds ("deep, slow"). Returns what was read and the OmniVoice instruct made of it."""
    p = profile or {}
    bits = [str(p.get("gender") or "").strip(), _age_word(str(p.get("age") or "").strip())]
    accent = str(p.get("accent") or "").strip()
    if accent:
        bits.append(accent if "accent" in accent.lower() else f"{accent} accent")
    elif p.get("nationality"):
        bits.append(f"{str(p['nationality']).strip()} accent")
    bits.append(" ".join((extra or "").split()))
    raw = ", ".join(b for b in bits if b)
    return raw, normalise(raw)
