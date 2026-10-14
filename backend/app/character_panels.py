"""The character sheet's panel catalogue (M12a). Plain data, so the ComfyUI driver can import it.

Character panels are edits of the approved portrait or of the sheet's full-body hero, never a fresh
text-to-image: that is what keeps the face the same from panel to panel. Props and accessories are the
exception: they're objects on their own, so they're plain product shots on the sheet's backdrop.
"""
from dataclasses import dataclass

# the podcast's sheet views (video_stages.sheets) still ask for these by name
VIEW_PROMPTS = {
    "front": "front view, facing the camera directly, full body, arms relaxed",
    "three_quarter": "three-quarter view, body turned 45 degrees from the camera, full body",
    "side": "side profile view, body turned 90 degrees, full body",
    "back": "back view, seen from directly behind, full body",
}
VIEW_ALIASES = {"3/4": "three_quarter", "3-4": "three_quarter", "34": "three_quarter", "profile": "side"}

KEEP = "Keep the face, hairstyle, body shape, clothing and colours exactly the same."
# one backdrop per sheet, so the board reads as one piece
BACKDROPS = {
    "grey": "Plain mid-grey seamless studio backdrop, soft even studio lighting, character sheet style.",
    "dark": "Plain near-black seamless backdrop, soft moody key light with a subtle rim light, character sheet style.",
}
FULL_BODY = (768, 1152)
HEAD = (768, 1024)
SQUARE = (1024, 1024)

SECTIONS = {
    "hero": "Hero",
    "turnaround": "Turnaround",
    "motion": "In motion",
    "head": "Head angles",
    "expressions": "Expressions",
    "closeup": "Close-up",
    "gestures": "Hand gestures",
    "postures": "Postures",
    "outfits": "Outfits",
    "details": "Wardrobe details",
    "props": "Props & weapons",
    "accessories": "Accessories",
}
# sections whose panels are full-body figures; the board gives them taller rows
TALL = ("turnaround", "motion", "postures", "outfits")


@dataclass(frozen=True)
class Panel:
    key: str
    section: str
    label: str
    source: str  # portrait | hero | none (an object made from text)
    ask: str  # what changes; the keep/backdrop sentences are added around it
    lora: bool = False  # the multiple-angles LoRA (Qwen edit) helps camera turns, not expressions
    size: tuple[int, int] = HEAD
    view: str | None = None  # the recorded view, for panels that are a camera turn


def _turn(view: str, label: str) -> Panel:
    return Panel(f"turn_{view}", "turnaround", label, "hero",
                 f"Show the same character from a new camera angle: {VIEW_PROMPTS[view]}.", True, FULL_BODY, view)


# the head grid: 3 tilts x 5 turns, the face-consistency reference (and a LoRA set later)
PITCHES = {"down": ("Down", "head tilted down, eyes looking down"), "level": ("Level", "head level"),
           "up": ("Up", "chin raised, looking up")}
YAWS = {"lprofile": ("L profile", "full left profile"), "l34": ("L ¾", "three-quarter view turned to the left"),
        "front": ("Front", "facing the camera"), "r34": ("R ¾", "three-quarter view turned to the right"),
        "rprofile": ("R profile", "full right profile")}


def _head(pitch: str, yaw: str) -> Panel:
    (pl, pt), (yl, yt) = PITCHES[pitch], YAWS[yaw]
    return Panel(f"head_{pitch}_{yaw}", "head", f"{yl} · {pl}", "portrait",
                 f"Show the same person's head and shoulders from a new camera angle: {yt}, {pt}.", True, HEAD,
                 f"{pitch}_{yaw}")


def _face(name: str, how: str) -> Panel:
    return Panel(f"expr_{name}", "expressions", name.capitalize(), "portrait",
                 f"Same person, head and shoulders, facing the camera, now with a {how} expression. "
                 "Only the facial expression changes.")


GESTURES = [("wave", "Wave", "an open hand raised in a wave"), ("point", "Point", "pointing forward with one hand"),
            ("count", "Counting", "holding up fingers as if counting"), ("fist", "Fist", "one hand clenched in a fist")]
POSTURES = [("relaxed", "Relaxed", "a relaxed, loose stance, weight on one leg"),
            ("tense", "Tense", "a tense, guarded stance, shoulders raised"),
            ("confident", "Confident", "a confident stance, chest open, hands on hips")]

CATALOGUE: dict[str, Panel] = {p.key: p for p in [
    Panel("hero", "hero", "Full body", "portrait",
          "Show this same person as a full-body standing pose, head to toe in frame, relaxed natural stance, "
          "arms at the sides, feet on the ground, wearing their signature outfit.", False, FULL_BODY),
    _turn("front", "Front"),
    _turn("three_quarter", "¾"),
    _turn("side", "Side"),
    _turn("back", "Back"),
    Panel("motion_walk", "motion", "Walking", "hero",
          "Same person, full body, mid-stride in a natural walk, seen at a slight three-quarter angle, arms swinging.",
          False, FULL_BODY),
    *[_head(p, y) for p in PITCHES for y in YAWS],
    _face("neutral", "calm neutral"),
    _face("smile", "warm genuine smiling"),
    _face("serious", "serious, focused"),
    _face("surprised", "surprised, eyebrows raised, mouth slightly open"),
    _face("sad", "sad, downcast"),
    _face("angry", "angry, brows drawn together, jaw tight"),
    _face("worried", "worried, uneasy"),
    _face("determined", "determined, resolute"),
    Panel("closeup", "closeup", "Close-up", "portrait",
          "Tight cinematic close-up of the same face, eyes sharp, soft key light with gentle falloff, "
          "shallow depth of field."),
    *[Panel(f"gesture_{k}", "gestures", label, "hero",
            f"Same person from the waist up, {how}, the hand clear and in focus.") for k, label, how in GESTURES],
    *[Panel(f"posture_{k}", "postures", label, "hero", f"Same person, full body, in {how}.", False, FULL_BODY)
      for k, label, how in POSTURES],
]}

EXPRESSIONS_4 = ["expr_neutral", "expr_smile", "expr_serious", "expr_surprised"]
EXPRESSIONS_8 = EXPRESSIONS_4 + ["expr_sad", "expr_angry", "expr_worried", "expr_determined"]
TURNAROUND = ["turn_front", "turn_three_quarter", "turn_side", "turn_back"]
HEAD_LEVEL = [f"head_level_{y}" for y in YAWS]
HEAD_GRID = [f"head_{p}_{y}" for p in PITCHES for y in YAWS]

# the lists sections take from the request (named items rather than counts)
LISTS = {"outfits": 3, "details": 4, "props": 3, "accessories": 6}
# custom sections and the counts each allows; hero always comes along
COUNTS = {
    "turnaround": (0, 4), "motion": (0, 1), "head": (0, 5, 15), "expressions": (0, 4, 8), "closeup": (0, 1),
    "gestures": (0, 1, 2, 3, 4), "postures": (0, 1, 2, 3),
}
PRESETS = {
    # 10 panels, a few minutes
    "essential": {"turnaround": 4, "expressions": 4, "closeup": 1},
    # 30 panels, plus whatever outfits, details, props and accessories are named
    "full": {"turnaround": 4, "motion": 1, "head": 15, "expressions": 8, "closeup": 1},
}
# what the UI shows before starting: one Qwen edit on the image GPU
SECONDS_PER_PANEL = (20, 40)


def _named(section: str, n: int, name: str) -> Panel:
    name = " ".join((name or "").split())
    label = name[:60] or f"{SECTIONS[section]} {n}"
    if section == "outfits":
        return Panel(f"outfit_{n}", section, label, "hero",
                     f"Same person in the same full-body pose, now wearing a different outfit: {name}. Keep the face, "
                     "hairstyle, skin tone and body shape exactly; only the clothing changes.", False, FULL_BODY)
    if section == "details":
        return Panel(f"detail_{n}", section, label, "hero",
                     f"Close-up detail shot of this character's {name}, as worn in the picture, filling the frame, "
                     "crisp texture, same colours and materials.")
    # props and accessories are objects alone: no person in the picture
    what = "prop" if section == "props" else "accessory"
    return Panel(f"{what}_{n}", section, label, "none",
                 f"Product photograph of a single {name}, the whole object in frame and centred, no person, no hands, "
                 "photorealistic, crisp detail.", False, SQUARE)


_PREFIX = {"outfit": "outfits", "detail": "details", "prop": "props", "accessory": "accessories"}


def panel(key: str, extras: dict | None = None) -> Panel | None:
    """A catalogue panel, or a named one (outfit / detail / prop / accessory) rebuilt from the sheet's names."""
    if key in CATALOGUE:
        return CATALOGUE[key]
    kind, _, n = key.rpartition("_")
    section = _PREFIX.get(kind)
    if section is None or not n.isdigit() or not 1 <= int(n) <= LISTS[section]:
        return None
    return _named(section, int(n), str((extras or {}).get(key) or ""))


def instruction(p: Panel, backdrop: str = "grey", note: str = "") -> str:
    """The prompt for a panel. Outfit, detail and object panels say themselves what may change."""
    text = p.ask
    if p.source != "none" and p.section not in ("outfits", "details"):
        text += f" {KEEP}"
    text += f" {BACKDROPS.get(backdrop, BACKDROPS['grey'])}"
    note = " ".join((note or "").split())
    return f"{text} {note}" if note else text


def _counted(section: str, n: int) -> list[str]:
    if section == "turnaround":
        return TURNAROUND[:n]
    if section == "motion":
        return ["motion_walk"][:n]
    if section == "head":
        return HEAD_GRID if n >= 15 else HEAD_LEVEL[:n]
    if section == "expressions":
        return EXPRESSIONS_8[:n]
    if section == "closeup":
        return ["closeup"][:n]
    if section == "gestures":
        return [f"gesture_{k}" for k, _, _ in GESTURES][:n]
    if section == "postures":
        return [f"posture_{k}" for k, _, _ in POSTURES][:n]
    return []


def counts_for(preset: str, custom: dict | None = None) -> dict[str, int]:
    """Section -> panel count. Custom counts snap down to what each section allows."""
    if preset != "custom":
        return dict(PRESETS.get(preset) or PRESETS["essential"])
    out = {}
    for section, allowed in COUNTS.items():
        want = int((custom or {}).get(section) or 0)
        out[section] = max(c for c in allowed if c <= max(0, want))
    return out


def panel_keys(preset: str, custom: dict | None = None, lists: dict[str, list[str]] | None = None) -> list[str]:
    keys = ["hero"]
    for section, n in counts_for(preset, custom).items():
        keys += _counted(section, n)
    if preset != "essential":
        for section, top in LISTS.items():
            prefix = next(k for k, v in _PREFIX.items() if v == section)
            keys += [f"{prefix}_{i}" for i, _ in enumerate(((lists or {}).get(section) or [])[:top], 1)]
    return keys


# ---------------------------------------------------------------- which panel a shot uses (storyboard.references_for)

EMOTIONS = {
    "expr_angry": ("angry", "anger", "furious", "rage", "glares", "shouts", "yells"),
    "expr_smile": ("smile", "smiles", "smiling", "laugh", "laughs", "laughing", "grin", "grins", "happy", "joy"),
    "expr_sad": ("sad", "cries", "crying", "tears", "weeps", "grief", "mourn"),
    "expr_surprised": ("surprised", "surprise", "shocked", "gasps", "astonished", "startled"),
    "expr_worried": ("worried", "anxious", "nervous", "afraid", "scared", "fear", "uneasy"),
    "expr_determined": ("determined", "resolute", "steely"),
    "expr_serious": ("serious", "stern", "grim", "focused"),
}
WIDE_SIZES = ("ls", "ews", "mls")
WIDE_TYPES = ("wide", "establishing", "long_take")
CLOSE_SIZES = ("ecu", "cu")
CLOSE_TYPES = ("close_up", "extreme_close_up", "insert")


def _says(text: str, *words: str) -> bool:
    import re

    return any(re.search(rf"\b{re.escape(w)}\b", text) for w in words)


def pick_for_shot(text: str, shot_type: str, rack: dict | None) -> list[str]:
    """Panel keys a shot would like for a character, best first. The caller falls back down the list to the
    first that exists, then to the portrait."""
    text = (text or "").lower()
    rack = rack or {}
    size, angle = rack.get("size"), rack.get("angle")
    wide = size in WIDE_SIZES or (size is None and shot_type in WIDE_TYPES)
    if angle == "ots" or shot_type == "over_shoulder" or _says(text, "over the shoulder", "over-the-shoulder"):
        return ["head_level_lprofile", "head_level_rprofile", "turn_side"]
    if wide:
        if _says(text, "from behind", "walks away", "back to camera", "seen from behind", "rear view"):
            return ["turn_back", "turn_front", "hero"]
        if _says(text, "profile", "side view", "from the side", "side-on"):
            return ["turn_side", "turn_front", "hero"]
        if _says(text, "three-quarter", "three quarter", "3/4"):
            return ["turn_three_quarter", "turn_front", "hero"]
        if _says(text, "walks", "walking", "runs", "running", "strides"):
            return ["motion_walk", "turn_front", "hero"]
        return ["turn_front", "hero"]
    if _says(text, "profile", "side view", "from the side"):
        return ["head_level_lprofile", "head_level_rprofile", "closeup"]
    for key, words in EMOTIONS.items():
        if _says(text, *words):
            return [key, "closeup" if (size in CLOSE_SIZES or shot_type in CLOSE_TYPES) else "portrait"]
    if size in CLOSE_SIZES or shot_type in CLOSE_TYPES:
        return ["closeup", "portrait"]
    return ["portrait"]


def estimate(n: int) -> dict:
    lo, hi = SECONDS_PER_PANEL
    return {"panels": n, "seconds_low": n * lo, "seconds_high": n * hi}


def catalogue_out() -> dict:
    """What the sheet picker needs to build presets and a live estimate on its own."""
    return {
        "sections": [{"key": k, "label": v} for k, v in SECTIONS.items()],
        "counts": {k: list(v) for k, v in COUNTS.items()},
        "lists": LISTS,
        "presets": {k: {"counts": v, "panels": len(panel_keys(k))} for k, v in PRESETS.items()},
        "backdrops": list(BACKDROPS),
        "seconds_per_panel": list(SECONDS_PER_PANEL),
    }
