"""The sound LTX-2.3 makes by itself, when no speech track is handed to it.

LTX writes the soundtrack in the same pass as the picture and fills in whatever the prompt leaves open, so a
prompt that never mentions sound often comes back with people talking in a language nobody speaks. Lightricks'
guide wants spoken words in quotes with the language named, and only English, French, Spanish, German and
Russian are validated for speech. Urdu or Hindi lines come out as babble, which is why shot dialogue in those
goes through our TTS and lip sync (app.shot_speech) and only reaches LTX as a last resort.
"""
import re

from app import aerab

QUOTED = re.compile('"([^"\n]+)"|“([^”\n]+)”|«([^»\n]+)»')
# anything that asks for a voice; "birds singing" lands here too, which only costs a softer clause
_TALK = re.compile(
    r"\b(say|says|said|saying|speak|speaks|speaking|spoke|talk|talks|talking|tell|tells|telling|whisper\w*|"
    r"shout\w*|yell\w*|scream\w*|call(?:s|ed|ing)? out|repl(?:y|ies|ied|ying)|answer\w*|ask(?:s|ed|ing)?|"
    r"sing|sings|singing|sang|chant\w*|narrat\w*|voice-?over|voices?|dialogue|conversation|chat(?:s|ting)?|"
    r"mutter\w*|murmur\w*|announc\w*|recit\w*|lip[- ]?sync\w*|interview\w*|podcast\w*|perform\w*|concert\w*|"
    r"choir\w*|rap|raps|rapp\w*|crowd\w*|cheer\w*|audience\w*)\b", re.I)

SILENT = "Nobody talks or sings: no dialogue, no speech, no voice-over; just the sounds of the scene."
MURMUR = "Any talking is quiet and indistinct, with no clear words."

# the script decides the language when it isn't Latin
_SCRIPTS = (("hi", re.compile("[ऀ-ॿ]")), ("pa", re.compile("[਀-੿]")), ("bn", re.compile("[ঀ-৿]")),
            ("zh", re.compile("[一-鿿]")), ("ja", re.compile("[぀-ヿ]")), ("ko", re.compile("[가-힯]")),
            ("ru", re.compile("[Ѐ-ӿ]")))
NAMES = {"en": "English", "hi": "Hindi", "pa": "Punjabi", "bn": "Bengali", "zh": "Mandarin Chinese",
         "ja": "Japanese", "ko": "Korean", "ru": "Russian", "es": "Spanish", "fr": "French", "de": "German",
         "pt": "Portuguese", "it": "Italian", "tr": "Turkish", **aerab.NAMES}

_EN = set("""the a an i i'm i've i'll you you're your he he's she she's it it's we we're they they're me my mine
him her his our us them their is are was were be been am do does did don't doesn't didn't not no yes yeah to of
and in on at for with from what what's where why how who when this that these those there here have has had will
would can can't could should just all so but if or oh well right now please okay ok hello hi hey thanks thank
sorry come go going let let's know think want need get got see look wait stop run help good time love like
really very much more never always tell said say one up out down back""".split())
# Roman Urdu / Hindi words that never pass for English ("main", "to", "na" do, so they aren't here)
_ROMAN_UR = set("""hai hain nahi nahin nai kya kyun kyon kyu mein mujhe mujh tum tumhe tumhein tumse aap hum
humein ka ki ke ko se tha thi thay yeh ye woh wo mera meri mere tera teri tere kar karo karna raha rahi rahe
ho hoon hun acha accha achha bohat bahut kuch sab jaan dil pyar pyaar yaar bhai abhi phir chalo kahan kaise kaisa
kaisi shukriya haan ji jee aur lekin magar kab jab tab apna apni apne bas zara""".split())


def quoted(text: str) -> list[str]:
    return [q.strip() for m in QUOTED.finditer(text or "") for q in m.groups() if q and q.strip()]


def looks_english(text: str) -> bool:
    """True when a line reads as English: Latin letters only and more English words than Roman Urdu ones."""
    if aerab.has_script(text) or any(rx.search(text or "") for _, rx in _SCRIPTS):
        return False
    words = re.findall(r"[a-z']+", (text or "").lower().replace("’", "'"))
    if not words or any(ord(ch) > 127 and ch.isalpha() for ch in text):
        return False
    en = sum(w in _EN for w in words)
    ur = sum(w in _ROMAN_UR for w in words)
    return en > 0 and ur * 2 <= en


def language_of(text: str) -> str | None:
    """The language code of a spoken line, or None for Latin text that isn't plainly English."""
    if aerab.has_script(text):
        return aerab.detect_language(text) or "ur"
    for code, rx in _SCRIPTS:
        if rx.search(text or ""):
            return code
    return "en" if looks_english(text) else None


def ltx_prompt(prompt: str) -> str:
    """The prompt LTX voices itself: quoted lines get their language named, and a prompt that asks for no
    speech says so outright. Idempotent, so a retried job doesn't stack clauses."""
    text = (prompt or "").rstrip()
    if SILENT in text or MURMUR in text or "The dialogue is spoken in" in text:
        return text
    lines = quoted(text)
    if lines:
        langs = {language_of(q) for q in lines}
        if len(langs) == 1 and None not in langs:
            name = NAMES.get(langs.pop())
            if name and f"in {name.lower()}" not in text.lower():
                return f"{text}\nThe dialogue is spoken in {name}."
        return text
    if _TALK.search(text):
        return f"{text}\n{MURMUR}"
    return f"{text}\n{SILENT}" if text else SILENT
