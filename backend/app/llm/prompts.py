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


def outline_messages(project) -> list[dict]:
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
