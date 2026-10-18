"""Our prompt text and the JSON shapes we ask for. Written from scratch for this app."""
import re
from typing import Iterable

from pydantic import BaseModel, Field, field_validator

from app import aerab
from app.schemas import flush_left

TIMES = ("dawn", "morning", "day", "golden_hour", "dusk", "night", "interior")

SCRIPT_RULES = """Formatting rules for script text:
- Plain text, every line flush-left. Never indent.
- Action in short present-tense paragraphs, written for the screen: what we see and hear.
- A character cue is the name in CAPS on its own line, e.g. MAYA or NARRATOR (V.O.); the dialogue goes on the next line.
- Parentheticals like (quietly) go on their own line between the cue and the dialogue.
- Leave one blank line between blocks.
- Do not repeat the scene heading, do not number anything, no markdown, no commentary."""


def _time(v: str | None) -> str | None:
    if not v:
        return None
    t = v.strip().lower().replace(" ", "_").replace("-", "_")
    if t in TIMES:
        return t
    for key, val in (("golden", "golden_hour"), ("sunset", "golden_hour"), ("sunrise", "dawn"), ("evening", "dusk"),
                     ("afternoon", "day"), ("noon", "day"), ("midnight", "night"), ("int", "interior")):
        if key in t:
            return val
    return None


class OutlineScene(BaseModel):
    heading: str
    logline: str
    purpose: str = ""
    time_of_day: str | None = None
    mood: str = ""
    duration_s: int = Field(30, ge=3, le=900)
    characters: list[str] = []

    @field_validator("time_of_day", mode="before")
    @classmethod
    def _norm_time(cls, v):
        return _time(v)


class OutlineCharacter(BaseModel):
    name: str
    role: str = ""


class Outline(BaseModel):
    logline: str
    characters: list[OutlineCharacter] = []
    scenes: list[OutlineScene] = Field(min_length=1)


class CharacterLook(BaseModel):
    name: str
    description: str


class CastLooks(BaseModel):
    characters: list[CharacterLook] = []


class SceneDraft(BaseModel):
    heading: str = ""
    logline: str = ""
    time_of_day: str | None = None
    mood: str = ""
    script_text: str

    @field_validator("time_of_day", mode="before")
    @classmethod
    def _norm_time(cls, v):
        return _time(v)


class NextScenes(BaseModel):
    scenes: list[OutlineScene] = Field(min_length=1)


def clean_script(text: str, heading: str = "") -> str:
    t = text.strip()
    t = re.sub(r"^```[a-z]*\n?|```$", "", t, flags=re.M).strip()
    t = flush_left(t)
    # models love to restate the slug line even when told not to
    lines = t.split("\n")
    if heading and lines and lines[0].strip().upper().rstrip(".") == heading.strip().upper().rstrip("."):
        t = "\n".join(lines[1:]).lstrip("\n")
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def clean_line(text: str) -> str:
    t = text.strip().strip('"').strip()
    return re.sub(r"\s+", " ", t)


def target_scene_count(runtime_s: int) -> int:
    # ~40 s per scene for shorts, longer scenes as the film grows
    per = 40 if runtime_s <= 600 else 90
    # TODO: feature-length runtimes need act-by-act outlining instead of a 24-scene cap
    return max(1, min(24, round(runtime_s / per)))


def words_for(duration_s: int) -> int:
    # screen time runs roughly 130 spoken/read words a minute
    return max(40, min(900, int(duration_s * 2.2)))


def film_language(project) -> str:
    """The film's spoken language (contract v4a, project.settings.language); English when unset."""
    return str((getattr(project, "settings", None) or {}).get("language") or "en").lower()


def language_name(code: str) -> str:
    from app.voices import lang_name

    return lang_name((code or "en").split("-")[0])


def language_note(language: str | None) -> str:
    """What a writer is told about a film that isn't in English; "" for English."""
    if not language or language == "en":
        return ""
    name = language_name(language)
    rule = aerab.writing_rule(language)
    return (f"The film is in {name}. Every spoken line and any words seen on screen (a sign, a letter, a caption) "
            f"are written in {name}. Scene headings, character cues and action lines stay in English so the crew "
            "can shoot from them." + (f" {name} text: {rule}" if rule else ""))


def character_line(c) -> str:
    desc = (c.description or "").strip()
    prof = getattr(c, "profile", None) or {}
    extra = "; ".join(f"{k}: {prof[k]}" for k in ("role", "age", "personality", "wardrobe") if prof.get(k))
    return f"- {c.name}: {desc or extra or 'no description yet'}" + (f" ({extra})" if desc and extra else "")


def film_block(project, characters: Iterable = ()) -> str:
    parts = [f"Title: {project.title}"]
    if project.logline:
        parts.append(f"Logline: {project.logline}")
    if project.brief and project.brief != project.logline:
        parts.append(f"Brief from the director: {project.brief}")
    parts.append(f"Target runtime: about {project.target_runtime_s} seconds")
    cast = [character_line(c) for c in characters]
    if cast:
        parts.append("Characters:\n" + "\n".join(cast))
    return "\n".join(parts)


def scene_brief(index: int, s, full: bool = False) -> str:
    head = f"Scene {index}: {s.heading or '(no heading)'}"
    gist = s.summary or s.logline
    if full and s.script_text:
        return f"{head}\n{s.script_text.strip()[:2500]}"
    if gist:
        return f"{head} — {gist}"
    if s.script_text:
        return f"{head} — {s.script_text.strip()[:400]}"
    return f"{head} — (empty)"


def context_block(scenes: list, idx: int, radius: int = 2) -> str:
    """Neighbouring scenes N-2..N+2; the immediate neighbours get their full text."""
    out = []
    for j in range(max(0, idx - radius), min(len(scenes), idx + radius + 1)):
        if j == idx:
            continue
        out.append(scene_brief(j + 1, scenes[j], full=abs(j - idx) == 1))
    return "\n\n".join(out) if out else "(no other scenes yet)"


DIRECTOR_SYSTEM = (
    "You are the director and story editor of a short film. You break a brief into a tight sequence of scenes "
    "that a small AI production can actually shoot: few locations, few characters, clear visual action. "
    "Every scene must move the story. Answer only with JSON matching the schema."
)

WRITER_SYSTEM = (
    "You are a screenwriter. You write lean, visual scenes with natural dialogue, in the voice and tone of the "
    "film you are given. You never contradict the established story or characters.\n\n" + SCRIPT_RULES
)


def writer_system(user: str, language: str | None = None) -> str:
    """The screenwriter's system prompt; a film in Urdu, Arabic... also gets the aerab rule, the language
    the film's own (contract v4a) or else read from the brief, the idea and the scenes around it."""
    rule = aerab.writing_rule(language if language and language != "en" else None, user)
    return WRITER_SYSTEM + (f"\n\nDialogue and narration: {rule}" if rule else "")


ADVERT_OUTLINE = ("This film is an advert for the brand below. Build the story around a moment where the product "
                  "belongs naturally, keep the brand's tone of voice, and leave room for the product and logo to be "
                  "seen on real things in the scenes (packaging, signage, screens, clothing, vehicles). The film ends on "
                  "a short packshot or logo reveal that is added for you, so the last scene should lead into it.")


def outline_messages(project, brand: str = "") -> list[dict]:
    n = target_scene_count(project.target_runtime_s)
    user = (
        f"{film_block(project)}\n\n"
        f"Plan about {n} scene{'s' if n != 1 else ''} whose durations add up to roughly {project.target_runtime_s} seconds.\n"
        "For each scene give: heading (a slug line like EXT. HARBOUR - NIGHT), a one-sentence logline, its purpose "
        "in the story, time_of_day (one of: " + ", ".join(TIMES) + "), mood (2-4 words), duration_s, and the "
        "names of the characters in it.\n"
        "Also give the film's logline in one sentence and the main characters (name plus a few words on their role). "
        "Keep the cast small and reuse names exactly."
    )
    if brand:
        user += f"\n\n{ADVERT_OUTLINE}\n{brand}"
    return [{"role": "system", "content": DIRECTOR_SYSTEM}, {"role": "user", "content": user}]


def looks_messages(project, outline_chars: list[tuple[str, str]], script_excerpt: str) -> list[dict]:
    names = "\n".join(f"- {n}: {r}" for n, r in outline_chars)
    user = (
        f"{film_block(project)}\n\nCharacters:\n{names}\n\nScript so far:\n{script_excerpt[:6000]}\n\n"
        "For each character write a physical description an image model can reproduce in every shot: "
        "apparent age, build, face, skin tone, hair (colour, length, style), and signature wardrobe with colours. "
        "One or two sentences, concrete and visual, no personality traits or backstory. Keep the names exactly."
    )
    return [{"role": "system", "content": "You are a casting director and costume designer. Answer only with JSON."},
            {"role": "user", "content": user}]


def draft_scene_messages(project, characters, scenes, idx: int, plan: dict | None = None, idea: str = "") -> list[dict]:
    s = scenes[idx]
    known = plan or {}
    heading = known.get("heading") or s.heading
    logline = known.get("logline") or s.logline
    duration = known.get("duration_s") or 30
    want = [f"This is scene {idx + 1} of {len(scenes)}."]
    if heading:
        want.append(f"Heading: {heading}")
    if logline:
        want.append(f"What happens: {logline}")
    if known.get("purpose"):
        want.append(f"Its job in the story: {known['purpose']}")
    if known.get("mood") or s.mood:
        want.append(f"Mood: {known.get('mood') or s.mood}")
    if known.get("characters"):
        want.append("Characters present: " + ", ".join(known["characters"]))
    if idea:
        want.append(f"The director's idea for this scene: {idea}")
    language = film_language(project)
    note = language_note(language)
    user = (
        f"{film_block(project, characters)}\n\nSurrounding scenes:\n{context_block(scenes, idx)}\n\n"
        + "\n".join(want)
        + f"\n\nWrite this scene in about {words_for(duration)} words. It must flow out of the scene before it "
        "and set up the scene after it."
        + (f"\n\n{note}" if note else "")
    )
    return [{"role": "system", "content": writer_system(user, language)}, {"role": "user", "content": user}]


def draft_json_messages(project, characters, scenes, idx: int, idea: str = "") -> list[dict]:
    msgs = draft_scene_messages(project, characters, scenes, idx, idea=idea)
    msgs[1]["content"] += (
        "\n\nAnswer as JSON with: heading (slug line; keep the given one if there is one), logline (one sentence), "
        "time_of_day (one of: " + ", ".join(TIMES) + "), mood (2-4 words), script_text (the scene itself, "
        "following the formatting rules, using \\n for line breaks)."
    )
    return msgs


def next_scenes_messages(project, characters, scenes, count: int) -> list[dict]:
    recent = "\n\n".join(scene_brief(i + 1, s, full=i == len(scenes) - 1) for i, s in enumerate(scenes[-4:], start=max(0, len(scenes) - 4)))
    user = (
        f"{film_block(project, characters)}\n\nThe film so far has {len(scenes)} scenes. The most recent:\n{recent}\n\n"
        f"Plan the next {count} scene{'s' if count != 1 else ''} that continue the story naturally. Same fields as an "
        "outline scene: heading, logline, purpose, time_of_day, mood, duration_s, characters."
    )
    return [{"role": "system", "content": DIRECTOR_SYSTEM}, {"role": "user", "content": user}]


ASSIST_INSTRUCTIONS = {
    "expand": "Expand this scene: deepen the action and texture, add beats and reactions, keep every existing story point "
    "and line of dialogue that matters. Roughly 1.5 to 2 times longer.",
    "tighten": "Tighten this scene: cut redundancy and flab, sharpen the action lines and dialogue, keep every story point. "
    "Roughly two thirds of the length.",
    "rewrite_tone": "Rewrite this scene in a {tone} tone. Keep the same events, characters and story function.",
    "write_dialogue": "Rework this scene's dialogue: give the characters natural, specific lines (add dialogue where the "
    "scene has none), and keep the action lines and events.",
}


def assist_messages(project, characters, scenes, idx: int, action: str, tone: str = "") -> list[dict]:
    s = scenes[idx]
    instr = ASSIST_INSTRUCTIONS[action].format(tone=tone or "different")
    user = (
        f"{film_block(project, characters)}\n\nSurrounding scenes:\n{context_block(scenes, idx)}\n\n"
        f"Scene {idx + 1}: {s.heading or '(no heading)'}\n---\n{s.script_text.strip()}\n---\n\n"
        f"{instr}\nReply with the full new scene text only."
    )
    return [{"role": "system", "content": writer_system(user)}, {"role": "user", "content": user}]


def logline_messages(project, scene) -> list[dict]:
    user = (
        f"Film: {project.title}. {project.logline}\n\nScene: {scene.heading}\n{scene.script_text.strip()[:5000]}\n\n"
        "Write this scene's logline: one sentence, present tense, under 25 words, saying what happens and why it matters. "
        "Reply with the sentence only."
    )
    return [{"role": "system", "content": "You are a story editor."}, {"role": "user", "content": user}]


def summary_messages(scene) -> list[dict]:
    user = (
        f"Scene: {scene.heading}\n{scene.script_text.strip()[:6000]}\n\n"
        "Summarise what happens in this scene in at most two sentences, naming the characters. "
        "This is a continuity note for the writers, so keep facts, props and outcomes. Reply with the summary only."
    )
    return [{"role": "system", "content": "You keep continuity notes for a film."}, {"role": "user", "content": user}]


def extract_messages(project, scripts: str, known: list[str]) -> list[dict]:
    have = ", ".join(known) if known else "none yet"
    user = (
        f"{film_block(project)}\n\nFull script:\n{scripts[:14000]}\n\nCharacters already on file: {have}.\n\n"
        "List every character who appears on screen or speaks (narrators count; crowds don't). Use the name as written "
        "in the script's character cues. For each, write a physical description an image model can reproduce: "
        "apparent age, build, face, skin tone, hair, and signature wardrobe with colours. Infer sensibly from the "
        "script and tone where it says nothing. One or two sentences, no personality."
    )
    return [{"role": "system", "content": "You are a casting director and costume designer. Answer only with JSON."},
            {"role": "user", "content": user}]


def portrait_messages(project, character) -> list[dict]:
    # a Character Studio character has no film around it
    film = (f"Film: {project.title}. {project.logline}\nAspect ratio of the film: {project.aspect_ratio}\n\n"
            if project is not None else "")
    infer = "(none — infer a fitting look from the film)" if project is not None else "(none — infer one from the name)"
    user = (
        f"{film}Character: {character.name}\nDescription: {character.description or infer}\n\n"
        "Write a text-to-image prompt for this character's reference portrait. It will anchor their look in every "
        "later shot, so: head-and-shoulders, facing the camera with a slight three-quarter turn, neutral expression, "
        "plain neutral grey studio background, soft even key light with gentle fill, photorealistic, sharp focus on "
        "the eyes, natural skin texture. Put the physical details first (age, face, skin, hair, wardrobe colours). "
        "One paragraph of comma-separated descriptive phrases, under 90 words. No negative prompt, no names of real "
        "people, no quotes. Reply with the prompt only."
    )
    return [{"role": "system", "content": "You write precise prompts for photorealistic image models."},
            {"role": "user", "content": user}]


class CharacterProfile(BaseModel):
    role: str = ""
    affiliation: str = ""
    nationality: str = ""
    height: str = ""
    age: str = ""
    gender: str = ""
    languages: str = ""
    personality: str = ""
    accent: str = ""
    wardrobe: str = ""
    # things the sheet can show on their own or close up
    props: list[str] = []
    accessories: list[str] = []
    details: list[str] = []


def profile_messages(character, film: str = "") -> list[dict]:
    """Character Studio's "Fill from description": the identity block plus items the sheet can show."""
    known = {k: v for k, v in (character.profile or {}).items() if v}
    rule = aerab.writing_rule(None, f"{character.name}. {character.description}")
    user = (
        (f"Film: {film}\n" if film else "")
        + f"Character: {character.name}\nDescription: {character.description or '(none)'}\n"
        + (f"Already decided (keep these, don't contradict them): {known}\n" if known else "")
        + "\nFill in a character profile for a reference sheet. role: what they do in the story, a few words. "
        "affiliation: team, family, company or side, if any. nationality, height (with units, e.g. 172 cm), "
        "age (a number or a range), gender, languages they speak, personality (three or four adjectives), accent "
        "(how they sound when they speak), wardrobe (their signature outfit in one line). Then list items for "
        "the sheet: props (up to 3 objects they carry or use, weapons too if the story has them), accessories "
        "(up to 6 worn items such as a watch, glasses, jewellery or a bag) and details (4 parts of their outfit "
        "worth a close-up). Infer sensibly from the description; leave a field empty rather than invent something "
        "that clashes with it. Short values, no full sentences."
        + (f" Write the values in the language of the description. {rule}" if rule else "")
    )
    return [{"role": "system", "content": "You are a costume designer and casting director. Answer only with JSON."},
            {"role": "user", "content": user}]


def rewrite_prompt_messages(prompt: str, note: str) -> list[dict]:
    user = (
        f"Image prompt that was used:\n{prompt}\n\nThe director's feedback on the result:\n{note}\n\n"
        "Rewrite the prompt so the next image fixes what the feedback asks for. Change only what the feedback "
        "concerns; keep subject, framing, style and every other detail. Make the requested change explicit and "
        "remove anything that contradicts it. Reply with the new prompt only."
    )
    return [{"role": "system", "content": "You revise prompts for image generation models."},
            {"role": "user", "content": user}]


# ---------------------------------------------------------------- storyboard

SHOT_TYPES = ("wide", "medium", "close_up", "extreme_close_up", "over_shoulder", "pov", "insert", "establishing",
              "long_take")


def _shot_type(v) -> str:
    t = str(v or "").strip().lower().replace("-", "_").replace(" ", "_")
    if t in SHOT_TYPES:
        return t
    for key, val in (("extreme", "extreme_close_up"), ("close", "close_up"), ("over", "over_shoulder"),
                     ("ots", "over_shoulder"), ("point", "pov"), ("insert", "insert"), ("estab", "establishing"),
                     ("wide", "wide"), ("long", "wide"), ("full", "wide")):
        if key in t:
            return val
    return "medium"


class PlacementIdea(BaseModel):
    """One brand moment as the planner proposes it; asset_id is a handle from the brief ("logo", "product1")."""
    asset_id: str
    surface: str = ""
    prominence: str = "background"

    @field_validator("prominence", mode="before")
    @classmethod
    def _prom(cls, v):
        return "hero" if str(v or "").strip().lower() in ("hero", "foreground", "primary", "main") else "background"


class DialogueIdea(BaseModel):
    character: str = ""
    text: str = ""


class ShotIdea(BaseModel):
    shot_type: str = "medium"
    duration_s: float = 4.0
    description: str
    camera: str = ""
    characters: list[str] = []
    start_visual: str = ""
    end_visual: str = ""
    handoff: str = ""
    continuous: bool = False
    brand_placements: list[PlacementIdea] = []
    dialogue: list[DialogueIdea] = []

    @field_validator("shot_type", mode="before")
    @classmethod
    def _norm_type(cls, v):
        return _shot_type(v)

    @field_validator("duration_s", mode="before")
    @classmethod
    def _clamp(cls, v):
        try:
            return max(1.0, min(20.0, float(v)))
        except (TypeError, ValueError):
            return 4.0


class ShotList(BaseModel):
    shots: list[ShotIdea] = Field(min_length=1)


class FramePrompts(BaseModel):
    start_prompt: str
    end_prompt: str
    motion_prompt: str


class SceneFrames(FramePrompts):
    shot_type: str = "medium"
    description: str = ""
    camera: str = ""
    characters: list[str] = []
    brand_placements: list[PlacementIdea] = []
    dialogue: list[DialogueIdea] = []

    @field_validator("shot_type", mode="before")
    @classmethod
    def _norm_type(cls, v):
        return _shot_type(v)


class LocationIdea(BaseModel):
    name: str
    description: str = ""
    time_of_day_variants: list[str] = []
    scenes: list[int] = []


class LocationList(BaseModel):
    locations: list[LocationIdea] = []


FRAME_RULES = """Rules for frame prompts (an image model sees each one alone, with no memory of the others):
- Reconstruct the whole world every time: who is in frame with their full physical description and wardrobe, where they are, the location's look, time of day and lighting, framing and lens.
- Describe one frozen moment, present tense, concrete and visual. No sounds, no thoughts, no story recap, no camera moves.
- Never use a character's name alone; describe the person each time (the name may follow the description).
- Plain text, flush-left, one paragraph each, under 110 words. No markdown, no lists, no quotes.
- Always in English, whatever language the film is in; never copy dialogue or words in another script into a prompt.
Rules for the motion prompt (a video model animates from the start frame to the end frame):
- Say what moves and how over the shot's duration: performance, gestures, the camera move, light changes. Keep it physically plausible for the duration.
- Never quote spoken words or copy dialogue from the script: the lines are voiced separately. Speech is performance only ("she answers him quietly").
- One paragraph, present tense, under 90 words, flush-left plain text."""


def _people(characters) -> str:
    rows = [f"- {c.name}: {c.description or 'no description yet'}" for c in characters]
    return "\n".join(rows) if rows else "(nobody in particular)"


def _place(location, scene) -> str:
    parts = []
    if location is not None:
        parts.append(f"Location: {location.name}. {location.description or ''}".strip())
    if scene is not None:
        parts.append(f"Scene heading: {scene.heading or '(none)'}")
        light = ", ".join(x for x in ((scene.time_of_day or "").replace("_", " "), scene.lighting, scene.mood) if x)
        if light:
            parts.append(f"Time, light and mood: {light}")
    return "\n".join(parts)


def _style(project) -> str:
    style = (getattr(project, "style_bible", "") or "").strip()
    return (f"Style Bible (copy it word for word at the end of every frame prompt):\n{style}" if style
            else "Style: photorealistic cinematic film still, natural colour, shallow depth of field.")


def dialogue_ask(scene, many: bool, language: str | None = None) -> str:
    """The storyboard's dialogue lines (contract v26): what is said on screen, word for word from the script,
    so it can be spoken in the characters' voices and lip-synced."""
    where = "each shot" if many else "the shot"
    lang = language if language and language != "en" else None
    rule = aerab.writing_rule(lang, scene.script_text or "")
    if lang:
        rule = f"in {language_name(lang)}, exactly as the script has it. {rule}".strip()
    ask = (f"Also give {where} dialogue: the lines spoken on screen in it, in order, as a list of "
           '{"character": the speaker\'s name exactly as in the cast list, "text": the words exactly as the script '
           "has them, in the script's own language}. No parentheticals, no stage directions, no voice-over or "
           "narration; an empty list where nobody speaks.")
    if many:
        ask += (" Put every line in the shot where it is spoken. Lip sync works best with one visible speaker, so "
                "favour singles and over-the-shoulder shots for talk.")
    return ask + (f"\nDialogue text: {rule}" if rule else "")


SHOTLIST_SYSTEM = (
    "You are a film director planning coverage. You break a scene into a short list of shots a small AI production "
    "can render: each shot is one continuous camera take between a start frame and an end frame. "
    "Answer only with JSON matching the schema."
)


def suggest_shots_messages(project, characters, scene, max_shots: int, previous=None, brand: str = "",
                           dialogue: bool = False, target_s: float | None = None) -> list[dict]:
    before = f"\nThe previous scene ends: {previous.summary or previous.logline or previous.heading}" if previous else ""
    # a long scene (contract v4a) is covered by many short shots that together fill its running time
    length = (f"The scene runs about {target_s:g} seconds on screen: plan about {max_shots} shots of 5-10 seconds "
              f"each whose duration_s add up to about {target_s:g}, covering the whole script. ") if target_s else ""
    user = (
        f"{film_block(project, characters)}\n\nScene: {scene.heading or '(no heading)'}\n---\n"
        f"{scene.script_text.strip()[:12000 if target_s else 6000]}\n---{before}\n\n{length}"
        f"Break this scene into at most {max_shots} shots, in order. For each shot give: shot_type (one of: "
        + ", ".join(SHOT_TYPES) + "), duration_s (1-20; time spoken lines at about 2.5 words a second), "
        "description (what happens, one or two sentences), camera (framing and any move), characters (names exactly "
        "as in the cast list), start_visual and end_visual (what the first and the last frame show), handoff (what "
        "carries over from the previous shot: a prop, a look, an emotion; empty for the first shot), and continuous "
        "(true only when the action flows straight on from the previous shot with no jump in time or place)."
    )
    if dialogue:
        user += "\n\n" + dialogue_ask(scene, True, film_language(project))
    if brand:
        user += "\n\n" + brand + "\nGive each shot brand_placements (an empty list where the brand doesn't fit)."
    return [{"role": "system", "content": SHOTLIST_SYSTEM}, {"role": "user", "content": user}]


BRAND_RULES = """Brand moments: this film is an advert. The brand's logo and products must appear INSIDE the scenes, on real things the story already has: packaging, a cup sleeve, signage, a billboard, a shop front, a phone or laptop screen, apparel, a vehicle, a tote bag.
- For a shot where it fits, give brand_placements: a list of {"asset_id": one of the ids below, "surface": the exact object it is printed on or the place it sits, "prominence": "hero" (the subject of the shot, front-facing and sharp) or "background" (visible but not the focus)}.
- At most two placements per shot. Not every shot needs one; it must feel natural, never a watermark, sticker or overlay. Plan at least one hero moment in the film.
- Hero moments need a calm frame: keep the camera slow and steady in those shots.
- Don't plan the closing packshot or logo reveal; it is added after your last shot."""


def brand_brief(context: str, assets: list[tuple[str, str]]) -> str:
    """The kit as the planner sees it: prompt_context, the placeable assets with their ids, and the rules."""
    rows = "\n".join(f"- {aid}: {what}" for aid, what in assets) or "- (no logo or product images yet)"
    return f"{context}\n\nBrand assets you can place (use the id exactly):\n{rows}\n\n{BRAND_RULES}"


class ShotPlacements(BaseModel):
    shot: int
    brand_placements: list[PlacementIdea] = []


class BrandMoments(BaseModel):
    shots: list[ShotPlacements] = []


def brand_moments_messages(project, shots: list[tuple[int, str]], brand: str) -> list[dict]:
    listing = "\n".join(f"Shot {n}: {text}" for n, text in shots)
    user = (
        f"Film: {project.title}. {project.logline}\n\nThe shot list, in order:\n{listing[:12000]}\n\n{brand}\n\n"
        "Answer as JSON: shots = a list of {\"shot\": the shot number, \"brand_placements\": [...]} for the shots "
        "that get a brand moment. Leave the others out."
    )
    return [{"role": "system", "content": SHOTLIST_SYSTEM}, {"role": "user", "content": user}]


def compile_messages(project, scene, shot, characters, location, prev_shot=None, linked: bool = False) -> list[dict]:
    lines = [
        f"Shot {shot.order} of the scene: {shot.shot_type.replace('_', ' ')}, {shot.duration_s:g} seconds.",
        f"What happens: {shot.description or '(see the scene)'}",
    ]
    if shot.camera:
        lines.append(f"Camera: {shot.camera}")
    if shot.prompt:
        lines.append(f"Director's notes for this shot: {shot.prompt}")
    if shot.start_prompt or shot.end_prompt:
        lines.append(f"Draft of the first frame: {shot.start_prompt or '-'}\nDraft of the last frame: {shot.end_prompt or '-'}")
    if shot.handoff_text:
        lines.append(f"Carried over from the previous shot: {shot.handoff_text}")
    if prev_shot is not None and linked and prev_shot.end_prompt:
        lines.append("This shot opens exactly on the previous shot's last frame, so the start frame must match it:\n"
                     + prev_shot.end_prompt)
    user = (
        f"Film: {project.title}. {project.logline}\n\nPeople in this shot:\n{_people(characters)}\n\n"
        f"{_place(location, scene)}\n\nScene script:\n{(scene.script_text or '').strip()[:3000]}\n\n"
        + "\n".join(lines) + f"\n\n{_style(project)}\n\n{FRAME_RULES}\n\n"
        "Answer as JSON with start_prompt (the first frame), end_prompt (the last frame) and motion_prompt."
    )
    return [{"role": "system", "content": "You write prompts for image and video generation models on a film set."},
            {"role": "user", "content": user}]


class NextBeat(BaseModel):
    description: str
    camera: str = ""
    end_prompt: str
    motion_prompt: str


def extend_messages(project, scene, shot, characters, location, duration_s: float, hint: str = "") -> list[dict]:
    """The beat right after `shot`: the new shot opens exactly on its last frame (Kling/Runway style extension)."""
    ask = (f"The director wants this to happen next: {hint}" if hint
           else "Decide the most natural next beat from the script; keep it small, it is a continuation, not a cut.")
    parts = [
        f"Film: {project.title}. {project.logline}",
        f"People:\n{_people(characters)}",
        _place(location, scene),
        f"Scene script:\n{(scene.script_text or '').strip()[:3000]}",
        f"The shot so far ({shot.shot_type.replace('_', ' ')}): {shot.description or '(see the scene)'}\n"
        f"Its last frame: {shot.end_prompt or shot.description or '-'}\n"
        f"Camera so far: {shot.camera or 'unspecified'}",
        f"Write the next {duration_s:g} seconds as a new shot that starts exactly on that last frame. {ask}",
        _style(project),
        FRAME_RULES,
        "Answer as JSON with description (what happens, one or two sentences), camera (framing and move), "
        "end_prompt (the new shot's last frame) and motion_prompt.",
    ]
    return [{"role": "system", "content": "You are a film director extending a shot by one beat."},
            {"role": "user", "content": "\n\n".join(parts)}]


def scene_frames_messages(project, characters, scene, location, duration_s: float, previous=None,
                          brand: str = "", dialogue: bool = False) -> list[dict]:
    before = ""
    if previous is not None:
        before = f"\nThe previous scene ends: {previous.summary or previous.logline or previous.heading}"
    user = (
        f"Film: {project.title}. {project.logline}\n\nCast:\n{_people(characters)}\n\n{_place(location, scene)}\n\n"
        f"Scene script:\n---\n{(scene.script_text or '').strip()[:6000]}\n---{before}\n\n"
        f"Treat the whole scene as one {duration_s:g}-second shot. Give: shot_type (one of: " + ", ".join(SHOT_TYPES)
        + "), description (one sentence), camera (framing and move), characters (names exactly as in the cast list, "
        "only those on screen), start_prompt = the frame the scene OPENS on, end_prompt = the frame it ENDS on, and "
        f"motion_prompt = what happens in between.\n\n{_style(project)}\n\n{FRAME_RULES}"
    )
    if dialogue:
        user += "\n\n" + dialogue_ask(scene, False, film_language(project))
    if brand:
        user += ("\n\n" + brand + "\nAlso give brand_placements for this shot (an empty list if the brand doesn't "
                 "fit here), and describe those objects in the start and end prompts.")
    return [{"role": "system", "content": "You are a director of photography writing prompts for image and video models. "
                                          "Answer only with JSON."},
            {"role": "user", "content": user}]


def extract_locations_messages(project, scenes, known: list[str]) -> list[dict]:
    listing = "\n\n".join(f"Scene {i}: {s.heading or '(no heading)'}\n{(s.script_text or '').strip()[:1200]}"
                          for i, s in enumerate(scenes, 1))
    have = ", ".join(known) if known else "none yet"
    user = (
        f"{film_block(project)}\n\nScenes:\n{listing[:14000]}\n\nLocations already on file: {have}.\n\n"
        "List every distinct location. Merge headings that are the same place (INT. BOAT - CABIN and INT. BOAT - "
        "CABIN - LATER are one). For each give: name (short, title case, reuse a name on file when it is the same "
        "place), description (what an establishing shot would show: architecture or landscape, materials, colours, "
        "props, scale; one or two sentences, no people), time_of_day_variants (the times of day it appears at, from: "
        + ", ".join(TIMES) + ") and scenes (the scene numbers set there)."
    )
    return [{"role": "system", "content": "You are a production designer and location scout. Answer only with JSON."},
            {"role": "user", "content": user}]


# ---------------------------------------------------------------- Poetry Shorts (contract v33)

class PoetryScene(BaseModel):
    image: str = Field(min_length=1)
    motion: str = ""


class PoetryScenes(BaseModel):
    character: str = ""
    setting: str = ""
    scenes: list[PoetryScene] = Field(min_length=1)


POETRY_RULES = """Rules:
- The same person in every scene, described the same way each time (age, build, clothing, colours). Nobody speaks
  or sings on screen: faces stay calm, mouths closed; the person is often seen from behind or at a distance.
- One setting family across the whole Short (the same city, valley or house), seen from new places. Let the light
  move on from scene to scene, for example golden hour, then dusk, then lantern-lit night.
- Follow the poem's imagery: what the lines say becomes what we see (dust, wind, rain, a candle, a door, petals).
- Motion is slow and cinematic: walking away, cloth or dust drifting, lanterns swaying, a slow push-in or drift.
  One move per scene, no cuts, no fast action.
- No text, letters, captions, signs or watermarks anywhere in the frame.
- Write in English. image: 40 to 80 words, the opening frame as a film still (subject, place, light, lens, colour).
  motion: 15 to 35 words, what moves and how the camera moves."""


def poetry_scene_messages(title: str, language: str, groups: list[list[str]], character: str, setting: str,
                          mood: str = "", aspect: str = "9:16") -> list[dict]:
    frame = {"9:16": "a vertical 9:16 frame", "1:1": "a square frame"}.get(aspect, "a wide 16:9 frame")
    poem = "\n\n".join(f"Scene {i}:\n" + "\n".join(lines) for i, lines in enumerate(groups, 1))
    parts = [f"A sung poem{f' called {title}' if title else ''}, in language '{language}', becomes a short film "
             f"in {frame}, one scene per group of lines.", f"The poem, grouped by scene:\n---\n{poem[:8000]}\n---",
             f"The person: {character or 'not given; choose one person who fits the poem and keep them'}",
             f"The setting: {setting or 'not given; choose one that fits the poem and keep it'}"]
    if mood:
        parts.append(f"Mood: {mood}")
    parts.append(POETRY_RULES)
    parts.append(f'Answer as JSON {{"character": "the person in one sentence", "setting": "the setting in one '
                 f'sentence", "scenes": [{{"image": "...", "motion": "..."}}]}} with exactly {len(groups)} scenes, '
                 "in order.")
    return [{"role": "system", "content": "You are a director of photography turning poetry into film. "
                                          "Answer only with JSON."},
            {"role": "user", "content": "\n\n".join(parts)}]


# ---------------------------------------------------------------- Ad Studio (contract v36)

AD_LAYOUTS = ("frosted", "side_wash", "bottom_bar", "split", "badge", "minimal", "cutout_blob", "arch_mask",
              "circle_mask", "big_price", "editorial", "before_after", "quote")
# what each layout is, for the creative director (and the style-reference reader)
AD_LAYOUT_NOTES = {
    "frosted": "copy on a frosted panel over the photo",
    "side_wash": "copy over a pale wash on one side of the photo",
    "bottom_bar": "a solid brand bar under the photo",
    "split": "photo and a colour block side by side",
    "badge": "a round price or discount badge on the photo (needs an approved offer with a number)",
    "minimal": "a short headline centred on calm space",
    "cutout_blob": "the person or product cut out, standing on an organic colour shape on a light ground",
    "arch_mask": "the photo inside a large arch on an off-white ground, headline on top",
    "circle_mask": "the photo inside a large circle on an off-white ground",
    "big_price": "huge headline and a colour band with the price number very large (needs an offer with a number)",
    "editorial": "oversized headline type with a small photo",
    "before_after": "two halves, before and after the work (only for visible transformations: cleaning, "
                    "renovation, gardening, styling)",
    "quote": "a customer's own quote set large (only when the client gave quotes)",
}
# the photoreal engines a concept may ask for when the brief leaves the model on auto
AD_PHOTO_MODELS = ("zimage_turbo", "qwen_image_2512")


class AdConcept(BaseModel):
    insight: str = ""
    kicker: str = ""
    headline: str = Field(min_length=1)
    body: str = ""
    offers: list[str] = []
    cta: str = ""
    layout: str = "frosted"
    photo_prompt: str = Field(min_length=1)
    photo_model: str = ""
    placement: str = ""
    logo_surface: str = ""
    # one word (or a short phrase) of the headline to set in the accent colour
    key_word: str = ""
    # quote layout: which of the client's quotes (1-based); never a quote of the model's own
    quote: int | None = None

    @field_validator("quote", mode="before")
    @classmethod
    def _quote(cls, v):
        try:
            return int(v) if v not in (None, "", 0) else None
        except (TypeError, ValueError):
            return None

    @field_validator("layout")
    @classmethod
    def _layout(cls, v):
        v = (v or "").strip().lower().replace(" ", "_").replace("-", "_")
        return v if v in AD_LAYOUTS else "frosted"

    @field_validator("photo_model")
    @classmethod
    def _photo_model(cls, v):
        v = (v or "").strip().lower().replace("-", "_")
        return v if v in AD_PHOTO_MODELS else ""


class AdConcepts(BaseModel):
    concepts: list[AdConcept] = Field(min_length=1)


# a few lines in the voice we want and the voice we don't. Kept generic on purpose: they teach the register,
# not a client's campaign
AD_EXAMPLES = {
    "sv": (["Tänd ljusen. Vi tar dammet.", "Släpp in höstljuset.", "Höstrusket stannar ute.",
            "Flytta med gott samvete.", "Kaffet är klart. Golven också."],
           ["Upplev skillnaden med renhet (översatt engelska)", "Din lösning för ett rent hem (tom abstraktion)",
            "Ta ditt hem till nästa nivå (lån från engelskan)", "Kvalitet möter omtanke (säger ingenting)"]),
    "en": (["Light the candles. We'll do the dusting.", "Leave the mud at the door.", "Coffee's on. Floors are done.",
            "Move out. Leave it spotless."],
           ["Experience the ultimate cleanliness solution (brochure-speak)",
            "Elevate your autumn living (empty abstraction)", "Where quality meets comfort (says nothing)",
            "Unlock a cleaner tomorrow (cliché)"]),
}

AD_RULES = """Copy rules:
- Write every word of copy (kicker, headline, body, offers, cta) in {language}, the way a native copywriter in
  {market} talks to neighbours: everyday spoken idiom, concrete and warm. Think in {language} from the start.
  Never translate an English idea word for word, never borrow English phrasing ("next level", "experience the
  difference", "your solution for"). If a line would sound odd said out loud at a kitchen table, rewrite it.
- One clear insight per concept: a real, recognisable moment or tension of the audience (wet boots in the
  hall, guests coming on Saturday, the first dark evenings), and the copy says that one thing.
- No empty abstractions: no "safety", "comfort", "quality", "threshold", "harmony" or other nouns that could
  sell anything. Name the thing itself: the dust, the window light, the moving boxes.
- headline: at most 5 words, a short spoken sentence or two. Put a line break (\\n) where a designer would
  break it, at most one. A question ends with a question mark and nothing after it.
- kicker: 2 to 4 words above the headline (the occasion, the moment, the place), no full stop at the end.
  body: one short line, two at most.
- cta: 1 to 3 words on a button (book, order, call...), in the imperative. It may name one of the brand's
  channels listed above the way people say it in {language} ("book via WhatsApp", "follow us on Instagram"),
  never a channel that isn't listed.
- Never write a handle, phone number, web address or email anywhere in the copy: the footer carries the real
  ones.
- offers: ONLY lines copied exactly from the approved offers below, the ones that suit this concept (zero to
  two). Never write a price, a percentage, a discount, a time limit, a guarantee or any other promise of your
  own, and no numbers anywhere in the copy unless they appear in the approved offers.
- layout: one of the layouts listed below. Vary the layouts across concepts: no two concepts on the same one
  unless there are more concepts than layouts.
- key_word: the one word of the headline (or two that belong together) a designer would set in the accent
  colour, copied exactly as it is written in the headline.
- Each concept is a different idea (insight): a different moment, angle or feeling, not a rewording."""

AD_PHOTO_RULES = """Photo rules (photo_prompt, in English, 50 to 90 words):
- A real moment, shot like an editorial lifestyle feature: people doing the work naturally and mid-action
  (hands on the task, not posing, not looking at the camera), or the lived-in result just after (a made bed,
  sunlight on a clean floor, a coat on the hook). Never a stiff person standing to attention, never an empty
  room with things hanging in it.
- Natural light from a window or the time of day, real textures, a believable home or workplace with local
  cues of {market} (architecture, interiors, weather, season, the light at that latitude).
- Name the subject, the setting, the action, the light, the lens (e.g. 35mm, shallow depth of field) and the
  mood. The brand's colours ({colours}) may appear in one or two natural things (a cushion, a towel, a mug),
  written as colour names, never as codes.
- Nothing random: no name badges, lanyards, stickers, odd emblems, floating objects or props the moment
  doesn't need, and no text, letters, numbers, signs, logos or watermarks anywhere in the picture.
- Copy space: describe the calm, uncluttered area the layout needs, in the words "copy space": {space}.
- cutout_blob: one person (or the product) whole and clearly outlined against a plain, light, uncluttered
  background, so it can be cut out cleanly; nothing in front of them.
- photo_model: "zimage_turbo" for people, hands and homes (natural skin, quick), or "qwen_image_2512" for
  detailed interiors, products, materials and crowded scenes.
- placement: where the subject sits in the frame, e.g. "right third, lower half".
- logo_surface: a surface in the photo that could carry the logo (a van door, an apron, a mug, a shop window), or
  "" when the logo should only be laid over the advert. Use it for at most one concept, and only when natural."""


def ad_copy_space(layout: str, rtl: bool) -> str:
    side, other = ("right", "left") if rtl else ("left", "right")
    return {
        "frosted": f"the upper {side} area, subject in the {other} part of the frame",
        "badge": f"the upper {side} area (a round badge goes in the top {other} corner)",
        "side_wash": f"the whole {side} half, subject on the {other}",
        "bottom_bar": "the bottom third, subject in the upper two thirds",
        "split": "none needed, the photo sits beside a colour block; the subject can fill the frame",
        "minimal": "the upper half, subject low in the frame",
        "cutout_blob": "none, one subject alone on a plain light background, clear outline",
        "arch_mask": "none, the subject centred with room around them",
        "circle_mask": "none, the subject centred with room around them",
        "big_price": f"the whole {side} half, subject on the {other}",
        "editorial": "none, a simple calm frame with the subject centred",
        "before_after": "none, a wide straight-on view of the whole space in even light",
        "quote": "the subject in the middle band of the frame, face clearly lit",
    }.get(layout, f"the upper {side} area")


def _examples(language: str) -> str:
    lang = (language or "").lower().split("-")[0]
    good, bad = AD_EXAMPLES.get(lang, AD_EXAMPLES["en"])
    head = "" if lang in AD_EXAMPLES else " (in English; aim for the same register in the ad's language)"
    return (f"The voice we want{head}:\n" + "\n".join(f"  GOOD: {g}" for g in good) + "\n"
            + "\n".join(f"  BAD: {b}" for b in bad))


def ad_concept_messages(*, brand: str, subject: str, description: str, brief: str, occasion: str, market: str,
                        language: str, tone: str, must_say: str, offers: list[str], count: int,
                        products: list[str], rtl: bool, avoid: list[str] | None = None,
                        channels: list[str] | None = None, colours: list[str] | None = None,
                        layouts: list[str] | None = None, quotes: list[dict] | None = None,
                        style_note: str = "") -> list[dict]:
    lang_name = aerab.NAMES.get(language, language)
    allowed = [x for x in (layouts or AD_LAYOUTS) if x in AD_LAYOUTS] or list(AD_LAYOUTS)
    spaces = "; ".join(f"{k} -> {ad_copy_space(k, rtl)}" for k in allowed)
    menu = "Layouts you may use:\n" + "\n".join(f"- {k}: {AD_LAYOUT_NOTES[k]}" for k in allowed)
    quote_list = "\n".join(f"{i}. \"{q['text']}\"" + (f" ({q['by']})" if q.get("by") else "")
                            for i, q in enumerate(quotes or [], 1))
    parts = [f"Write {count} advert concept{'s' if count > 1 else ''} for social media.",
             f"The brand:\n{brand}" if brand else "",
             f"What we advertise: {subject}" + (f" ({description})" if description else ""),
             f"The client's brief: {brief}" if brief else "No brief: find the strongest ideas yourself.",
             f"Occasion or season: {occasion}" if occasion else "",
             f"Market: {market}" if market else "",
             f"Tone: {tone}" if tone else "",
             f"Must say (keep its meaning in every concept): {must_say}" if must_say else "",
             ("Approved offers (copy them exactly, or leave them out):\n" + "\n".join(f"- {o}" for o in offers))
             if offers else "Approved offers: none. Do not mention any price, discount or promise.",
             ("The brand's channels (the only ones a CTA may name): " + ", ".join(channels)) if channels else
             "The brand's channels: none listed. Don't name any platform, app or website.",
             ("The real product appears in the photo from the client's own pictures: "
              + "; ".join(products) + ". Describe the scene around it; the product itself stays as it is.")
             if products else "",
             ("Already written, do something different from: " + " | ".join(avoid)) if avoid else "",
             ("The client's own customer quotes (a quote layout uses one of these word for word; give its "
              "number in \"quote\"; never write a quote yourself):\n" + quote_list) if quotes else "",
             f"The brand's own adverts look like this; stay in that style: {style_note}" if style_note else "",
             AD_RULES.format(language=lang_name, market=market or "the target market"),
             menu,
             _examples(language),
             AD_PHOTO_RULES.format(market=market or "the target market",
                                   colours=", ".join(colours or []) or "the brand's colours",
                                   space=f"match it to the layout you chose ({spaces})")]
    rule = aerab.writing_rule(language)
    if rule:
        parts.append(rule)
    parts.append(f'Answer as JSON {{"concepts": [{{"insight": "...", "kicker": "...", "headline": "...", '
                 f'"body": "...", "offers": ["..."], "cta": "...", "layout": "{allowed[0]}", "key_word": "...", '
                 f'"photo_prompt": "...", "photo_model": "zimage_turbo", "placement": "...", "logo_surface": "", '
                 f'"quote": null}}]}} with exactly {count} concepts.')
    return [{"role": "system", "content": "You are the creative director and senior copywriter of an advertising "
                                          f"agency in {market or 'the target market'}, writing in your mother "
                                          f"tongue, {lang_name}. Answer only with JSON."},
            {"role": "user", "content": "\n\n".join(p for p in parts if p)}]


AD_CHECK_FIELDS = ("kicker", "headline", "body", "cta")


class AdLineCheck(BaseModel):
    concept: int = 0
    field: str = ""
    score: int = 5
    issue: str = ""
    rewrite: str = ""

    @field_validator("field")
    @classmethod
    def _field(cls, v):
        return (v or "").strip().lower()

    @field_validator("score", mode="before")
    @classmethod
    def _score(cls, v):
        try:
            return max(1, min(5, int(float(v))))
        except (TypeError, ValueError):
            return 5


class AdCopyCheck(BaseModel):
    lines: list[AdLineCheck] = []


def ad_copy_check_messages(*, language: str, market: str, concepts: list[dict]) -> list[dict]:
    """The self-check: a native editor scores every line and rewrites the ones that sound translated."""
    lang_name = aerab.NAMES.get(language, language)
    rows = []
    for i, c in enumerate(concepts, 1):
        for f in AD_CHECK_FIELDS:
            text = (c.get(f) or "").strip()
            if text:
                rows.append(f"{i}. {f}: {text!r}")
    parts = [f"You are a native {lang_name} copy editor in {market or 'the target market'}. Read these advert "
             "lines out loud in your head and score each one from 1 to 5: 5 is what a good local copywriter "
             "would write, 3 is understandable but stiff, 1 is translated English or nonsense.",
             "\n".join(rows),
             "For every line scoring 3 or lower, write a better one that says the same thing the way people "
             f"really talk in {lang_name}: concrete, idiomatic, no empty abstractions. Keep each rewrite within "
             "the same limits: headline at most 5 words (keep a \\n line break if there was one), kicker 2 to 4 "
             "words with no full stop, cta 1 to 3 words in the imperative. Add no numbers, prices, promises, "
             "handles or links the line didn't have. Lines scoring 4 or 5 get an empty rewrite.",
             "issue: a few words in English on what's wrong (\"literal translation\", \"abstract\", "
             "\"awkward word order\"), empty when nothing is.",
             _examples(language)]
    rule = aerab.writing_rule(language)
    if rule:
        parts.append(rule)
    parts.append('Answer as JSON {"lines": [{"concept": 1, "field": "headline", "score": 4, "issue": "", '
                 '"rewrite": ""}]} with one entry per line above.')
    return [{"role": "system", "content": "You edit advertising copy for native fluency. Answer only with JSON."},
            {"role": "user", "content": "\n\n".join(parts)}]


class AdHeadlineOption(BaseModel):
    headline: str = ""
    key_word: str = ""
    score: float = 0

    @field_validator("score", mode="before")
    @classmethod
    def _score(cls, v):
        try:
            return max(0.0, min(10.0, float(v)))
        except (TypeError, ValueError):
            return 0.0


class AdHeadlineSet(BaseModel):
    concept: int = 0
    options: list[AdHeadlineOption] = []


class AdHeadlines(BaseModel):
    concepts: list[AdHeadlineSet] = []


def ad_headline_messages(*, language: str, market: str, concepts: list[dict], per: int = 12) -> list[dict]:
    """The creative director's headline round: about a dozen headlines per concept, ranked by their author."""
    lang_name = aerab.NAMES.get(language, language)
    rows = [f"{i}. insight: {(c.get('insight') or '')!r}; headline now: {(c.get('headline') or '')!r}; "
            f"body: {(c.get('body') or '')!r}" for i, c in enumerate(concepts, 1)]
    parts = [f"You are the creative director. For each advert concept below write {per} different headlines in "
             f"{lang_name} for {market or 'the target market'} (keep the current one among them if it is good), "
             "then score every one from 0 to 10 for how a native reader would stop scrolling for it: concrete, "
             "spoken, true to the insight. Order each list best first.",
             "\n".join(rows),
             "Rules: at most 5 words; a \\n where a designer would break the line (at most one); no numbers, "
             "prices, promises, handles or links that the concept doesn't already have; no empty abstractions. "
             "key_word: the one word (or two that belong together) to set in the accent colour, copied exactly "
             "from that headline.",
             _examples(language)]
    rule = aerab.writing_rule(language)
    if rule:
        parts.append(rule)
    parts.append('Answer as JSON {"concepts": [{"concept": 1, "options": [{"headline": "...", "key_word": "...", '
                 '"score": 8}]}]} with one entry per concept.')
    return [{"role": "system", "content": "You write and judge advertising headlines. Answer only with JSON."},
            {"role": "user", "content": "\n\n".join(parts)}]
