"""Ideogram 4 captions: the model was trained on structured JSON captions, and its built-in safety filter
blocks plain-text prompts far more often (a harmless coffee poster came back "blocked" on 22 Oct, the same
idea as a caption rendered cleanly). The creative LLM writes the caption before the GPU step; the user's
prompt stays readable in the Library and the caption rides along in params.
"""
import json
import logging
import math
import re

from pydantic import BaseModel, Field

from app.llm.client import LLMError, chat_sync
from app.prompt_enhance import quoted

log = logging.getLogger("mixai.ideogram")

MODEL_ID = "ideogram4"
MAX_ELEMENTS = 8
# a faint grey name came back when the desc gave no colour
PLAIN_TEXT = "Clear, legible lettering, as written, in a colour that stands out strongly from the background."
MEDIUMS = ("photograph", "illustration", "3d_render", "painting", "graphic_design")
# clauses of the user's prompt that say how lettering should look; they go into every text element
_TYPE_WORDS = re.compile(r"typograph|font|letter|calligraph|serif|script|typeface|handwrit|\bcaps\b",
                         re.I)
_QUOTE_STRIP = re.compile(r'"[^"\n]*"|“[^”\n]*”')
# what a lazy desc tends to say; the renderer prints such words, "Subject" turned up on a logo on 22 Oct
_LAZY = re.compile(r"\b(subject|text logo|the text|logo text|label)\b", re.I)

SYSTEM = """You turn an image idea into the JSON caption the Ideogram 4 renderer reads.

Return one JSON object with these keys:
- high_level_description: one sentence (under 50 words) naming the subject, the medium and the overall
  composition. Start with the subject itself, never "this image shows".
- style_description: aesthetics (a few keywords), lighting (one phrase), medium (photograph, illustration,
  3d_render, painting or graphic_design), color_palette (3-6 hex colours).
- background: the scene shell only - backdrop, walls, floor or ground, sky, weather, scene-wide light.
- elements: up to 8 things placed in the picture, front-most last. Each has type "obj" or "text",
  bbox [top, left, bottom, right] on a 0-1000 grid of the canvas, desc (one to three short sentences: what
  it is, its colours and materials, where it sits) and, for type "text", text: the exact characters to print.

Rules:
- One subject is one element (a person, a car, a cup with its saucer). Its parts go in its desc.
- Anything in background must not be repeated as an element. The floor or ground is always background.
- Every quoted phrase in the idea becomes a "text" element with exactly those characters, same spelling,
  same case, same accents. Never translate, correct or drop them, and add no other words to print.
- A text element's desc says how the letters look (typeface style, weight, colour, size) and where they
  sit. Never write words like "subject" or "text logo" in it: the renderer may print them.
- Text runs left to right, so a text bbox is wider than it is tall. Put long names on two lines with "\\n".
- high_level_description names every quoted phrase too.
- Plain, physical descriptions: colours, shapes, materials. No praise words, no camera jargon in descs.
- Keep the layout sensible for the canvas aspect ratio you are given.

Example. Aspect ratio: 2:3. Idea: bakery poster, a basket of fresh bread, "Daily Bread" in bold brown
rounded type, warm and rustic.
{"high_level_description": "A rustic bakery poster with a wicker basket of fresh loaves under the bold
headline 'Daily Bread'.", "style_description": {"aesthetics": "warm, rustic, simple", "lighting": "soft warm
daylight", "medium": "graphic_design", "color_palette": ["#F4E8D0", "#6B3E26", "#C8893F"]}, "background":
"A plain warm cream backdrop above a worn wooden table top.", "elements": [{"type": "text", "bbox": [70, 100,
230, 900], "text": "Daily Bread", "desc": "Bold rounded sans-serif headline in dark brown, large, centred
across the top."}, {"type": "obj", "bbox": [430, 150, 900, 850], "desc": "A wicker basket of crusty golden
loaves and baguettes on the table, centred in the lower half."}]}"""


class Style(BaseModel):
    aesthetics: str = ""
    lighting: str = ""
    medium: str = ""
    color_palette: list[str] = Field(default_factory=list)


class Element(BaseModel):
    type: str = "obj"
    bbox: list[float] | None = None
    desc: str = ""
    text: str | None = None


class Caption(BaseModel):
    high_level_description: str
    style_description: Style = Field(default_factory=Style)
    background: str = ""
    elements: list[Element] = Field(default_factory=list)


def is_caption(prompt: str) -> bool:
    """Already a JSON caption (pasted by hand or made earlier): used as it is."""
    text = (prompt or "").strip()
    if not text.startswith("{"):
        return False
    try:
        data = json.loads(text)
    except ValueError:
        return False
    return isinstance(data, dict) and "high_level_description" in data


def aspect(width: int, height: int) -> str:
    g = math.gcd(int(width), int(height)) or 1
    return f"{int(width) // g}:{int(height) // g}"


def _medium(raw: str) -> str:
    m = re.sub(r"[\s-]+", "_", (raw or "").strip().lower())
    return m if m in MEDIUMS else ""


def _type_hint(prompt: str) -> str:
    clauses = [c.strip() for c in re.split(r"[,;\n]", _QUOTE_STRIP.sub("", prompt)) if _TYPE_WORDS.search(c)]
    return "; ".join(clauses)[:200]


def _text_box(box: list[int] | None, text: str, ratio: str) -> list[int] | None:
    """A text box taller than its lines need gets the letters stood on end; better to let the model place it."""
    if not box:
        return None
    w, h = (int(v) for v in ratio.split(":"))
    lines = text.count("\n") + 1
    px_w, px_h = (box[3] - box[1]) * w, (box[2] - box[0]) * h
    return box if px_h <= px_w * 0.6 * lines else None


def _bbox(raw) -> list[int] | None:
    if not raw or len(raw) != 4:
        return None
    try:
        y1, x1, y2, x2 = (max(0, min(1000, int(round(float(v))))) for v in raw)
    except (TypeError, ValueError):
        return None
    if y2 <= y1 or x2 <= x1:
        return None
    return [y1, x1, y2, x2]


def assemble(cap: Caption, prompt: str, ratio: str) -> str:
    """The caption as the renderer wants it, with every quoted phrase of the prompt printed verbatim."""
    elements = []
    hint = _type_hint(prompt)
    for e in cap.elements[:MAX_ELEMENTS]:
        kind = "text" if e.type == "text" and (e.text or "").strip() else "obj"
        if not e.desc.strip() and kind == "obj":
            continue
        item: dict = {"type": kind}
        box = _bbox(e.bbox)
        desc = e.desc.strip()
        if kind == "text":
            box = _text_box(box, e.text.strip(), ratio)
            if len(desc.split()) < 4 or _LAZY.search(desc):
                desc = ""
            desc = _with_hint(desc or PLAIN_TEXT, hint)
        if box:
            item["bbox"] = box
        if kind == "text":
            item["text"] = e.text.strip()
        item["desc"] = desc
        elements.append(item)
    printed = {el.get("text") for el in elements}
    for words in quoted(prompt):
        # the LLM paraphrased or dropped a quoted line: the user's characters win
        if words not in printed:
            elements = [el for el in elements if not (el["type"] == "text" and _close(el["text"], words))]
            elements.append({"type": "text", "text": words,
                             "desc": _with_hint(PLAIN_TEXT, hint)})
    _lockup(elements)
    style = cap.style_description.model_dump()
    style["medium"] = _medium(style["medium"])
    style = {k: v for k, v in style.items() if v}
    out: dict = {"aspect_ratio": ratio, "high_level_description": cap.high_level_description.strip()}
    if style:
        out["style_description"] = style
    out["compositional_deconstruction"] = {"background": cap.background.strip() or "A plain, simple backdrop.",
                                           "elements": elements}
    return json.dumps(out, ensure_ascii=False)


def _lockup(elements: list[dict]) -> None:
    """Placed pictures but unplaced words: the renderer squeezed the name into the middle of the emblem at a
    few pixels high (Ouroboros, 22 Oct). Stack the words in a band at the bottom and fit the pictures above."""
    texts = [el for el in elements if el["type"] == "text"]
    placed = [el for el in elements if el["type"] == "obj" and "bbox" in el]
    if not texts or not placed or any("bbox" in t for t in texts):
        return
    heights = [(150 if i == 0 else 90) * (t["text"].count("\n") + 1) for i, t in enumerate(texts)]
    top = max(560, 1000 - 50 - sum(heights))
    scale = min(1.0, (1000 - 50 - top) / sum(heights))
    y = top
    for t, h in zip(texts, heights):
        h = int(h * scale)
        t["bbox"] = [y, 80, y + h, 920]
        y += h
    limit = top - 30
    for el in placed:
        y1, x1, y2, x2 = el["bbox"]
        if y2 <= limit:
            continue
        old_h = max(1, y2 - y1)
        y1 = min(y1, 60)
        # shrink about the centre line so the emblem keeps its shape
        k = (limit - y1) / old_h
        cx, half = (x1 + x2) / 2, (x2 - x1) * k / 2
        el["bbox"] = [y1, int(cx - half), limit, int(cx + half)]


def _with_hint(desc: str, hint: str) -> str:
    if not hint or hint.casefold() in desc.casefold():
        return desc
    return f"{desc.rstrip('.')}. Lettering: {hint}."


def _close(a: str, b: str) -> bool:
    a, b = a.casefold(), b.casefold()
    return a in b or b in a


def fallback(prompt: str, ratio: str) -> str:
    """No LLM: still a caption, which the filter takes far better than bare text."""
    cap = Caption(high_level_description=prompt.strip()[:600], background="")
    return assemble(cap, prompt, ratio)


def write(prompt: str, width: int, height: int, *, tick=None) -> tuple[str, bool]:
    """(caption, by_llm)."""
    ratio = aspect(width, height)
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Aspect ratio: {ratio}\nIdea: {prompt.strip()}"}]
    try:
        res = chat_sync("creative", msgs, tick=tick, schema=Caption, think=False, temperature=0.4,
                        max_tokens=1400, timeout=120)
    except LLMError as e:
        log.warning("ideogram caption fell back to a plain wrapper: %s", e)
        return fallback(prompt, ratio), False
    return assemble(res.data, prompt, ratio), True


def run_in_job(ctx, gen) -> None:
    params = dict(gen.params or {})
    if params.get("model") != MODEL_ID or params.get("ideogram_caption") or is_caption(gen.prompt or ""):
        return
    ctx.progress(0.02, "Laying out the picture")
    # TODO: Print/Ad Studio know their exact lines and zones; pass those in instead of re-reading the prose
    caption, by_llm = write(gen.prompt or "", params.get("width") or 1024, params.get("height") or 1024,
                            tick=lambda: ctx.progress(0.02, "Laying out the picture"))
    params.update(ideogram_caption=caption, ideogram_caption_by="llm" if by_llm else "fallback")
    gen.params = params
    ctx.db.commit()
