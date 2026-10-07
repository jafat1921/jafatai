"""Our prompt text and the JSON shapes we ask for. Written from scratch for this app."""
import re
from typing import Iterable

from pydantic import BaseModel, Field, field_validator

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


def film_block(project, characters: Iterable = ()) -> str:
    parts = [f"Title: {project.title}"]
    if project.logline:
        parts.append(f"Logline: {project.logline}")
    if project.brief and project.brief != project.logline:
        parts.append(f"Brief from the director: {project.brief}")
    parts.append(f"Target runtime: about {project.target_runtime_s} seconds")
    cast = [f"- {c.name}: {c.description or 'no description yet'}" for c in characters]
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
    user = (
        f"{film_block(project, characters)}\n\nSurrounding scenes:\n{context_block(scenes, idx)}\n\n"
        + "\n".join(want)
        + f"\n\nWrite this scene in about {words_for(duration)} words. It must flow out of the scene before it "
        "and set up the scene after it."
    )
    return [{"role": "system", "content": WRITER_SYSTEM}, {"role": "user", "content": user}]


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
    return [{"role": "system", "content": WRITER_SYSTEM}, {"role": "user", "content": user}]


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
    user = (
        f"Film: {project.title}. {project.logline}\nAspect ratio of the film: {project.aspect_ratio}\n\n"
        f"Character: {character.name}\nDescription: {character.description or '(none — infer a fitting look from the film)'}\n\n"
        "Write a text-to-image prompt for this character's reference portrait. It will anchor their look in every "
        "later shot, so: head-and-shoulders, facing the camera with a slight three-quarter turn, neutral expression, "
        "plain neutral grey studio background, soft even key light with gentle fill, photorealistic, sharp focus on "
        "the eyes, natural skin texture. Put the physical details first (age, face, skin, hair, wardrobe colours). "
        "One paragraph of comma-separated descriptive phrases, under 90 words. No negative prompt, no names of real "
        "people, no quotes. Reply with the prompt only."
    )
    return [{"role": "system", "content": "You write precise prompts for photorealistic image models."},
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
Rules for the motion prompt (a video model animates from the start frame to the end frame):
- Say what moves and how over the shot's duration: performance, gestures, the camera move, light changes. Keep it physically plausible for the duration.
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


SHOTLIST_SYSTEM = (
    "You are a film director planning coverage. You break a scene into a short list of shots a small AI production "
    "can render: each shot is one continuous camera take between a start frame and an end frame. "
    "Answer only with JSON matching the schema."
)


def suggest_shots_messages(project, characters, scene, max_shots: int, previous=None, brand: str = "") -> list[dict]:
    before = f"\nThe previous scene ends: {previous.summary or previous.logline or previous.heading}" if previous else ""
    user = (
        f"{film_block(project, characters)}\n\nScene: {scene.heading or '(no heading)'}\n---\n"
        f"{scene.script_text.strip()[:6000]}\n---{before}\n\n"
        f"Break this scene into at most {max_shots} shots, in order. For each shot give: shot_type (one of: "
        + ", ".join(SHOT_TYPES) + "), duration_s (1-20; time spoken lines at about 2.5 words a second), "
        "description (what happens, one or two sentences), camera (framing and any move), characters (names exactly "
        "as in the cast list), start_visual and end_visual (what the first and the last frame show), handoff (what "
        "carries over from the previous shot: a prop, a look, an emotion; empty for the first shot), and continuous "
        "(true only when the action flows straight on from the previous shot with no jump in time or place)."
    )
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


def scene_frames_messages(project, characters, scene, location, duration_s: float, previous=None,
                          brand: str = "") -> list[dict]:
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
