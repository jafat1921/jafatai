"""The Ad Studio's eye (M16b): picks the best of the candidate photos, checks the finished adverts and reads
the brand's own adverts for their style.

Which model looks: ADS_VISION_MODEL, else LLM_MODEL_VISION, else the copywriter, the first one Ollama's
/api/show says has the "vision" capability. An OpenAI-compatible server can't be asked, so the configured
vision models are trusted there. No model, or a failed call, is never fatal: the photo pick falls back to
heuristics and the QA to the layout's own measurements.
"""
import asyncio
import base64
import io
import logging
from collections import Counter

from PIL import Image
from pydantic import BaseModel, Field, field_validator

from app.config import get_settings
from app.llm import LLMError, chat_sync
from app.llm.client import capabilities
from app.llm.prompts import AD_LAYOUT_NOTES, AD_LAYOUTS

log = logging.getLogger("mixai.ads")

MAX_SIDE = 896


class Unavailable(RuntimeError):
    pass


def pick_model(candidates: list[str], ask, trusted: set[str]) -> str | None:
    """The first candidate with vision. `ask(name)` gives Ollama's capability list, None when it can't tell."""
    for name in dict.fromkeys(c for c in candidates if c):
        try:
            caps = ask(name)
        except LLMError as e:
            log.info("couldn't ask the LLM server about %s (%s)", name, e)
            return None
        if caps is None:
            if name in trusted:
                return name
            continue
        if "vision" in caps:
            return name
    return None


def vision_model(writer: str | None = None) -> str | None:
    s = get_settings()
    trusted = {x for x in (s.ads_vision_model.strip(), s.llm_model_vision) if x}
    return pick_model([s.ads_vision_model.strip(), s.llm_model_vision, writer or ""],
                      lambda n: asyncio.run(capabilities(n)), trusted)


def b64(img: Image.Image, max_side: int = MAX_SIDE) -> str:
    im = img.convert("RGB")
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=86)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _box(v) -> list[float]:
    try:
        x0, y0, x1, y1 = (max(0.0, min(1.0, float(a))) for a in list(v)[:4])
    except (TypeError, ValueError):
        return []
    if len(list(v)) != 4:
        return []
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    return [round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)] if x1 - x0 > 0.02 and y1 - y0 > 0.02 else []


def _clamp10(v):
    try:
        return max(0.0, min(10.0, float(v)))
    except (TypeError, ValueError):
        return 5.0


# ---------------------------------------------------------------- the best of the candidates

class AdPhotoScore(BaseModel):
    score: float = 5.0
    garbled_text: bool = False
    hands_faces_ok: bool = True
    copy_space_ok: bool = True
    mood: float = 5.0
    sharp: bool = True
    issues: list[str] = []
    subject_box: list[float] = []
    face_box: list[float] = []

    _c = field_validator("score", "mood", mode="before")(lambda cls, v: _clamp10(v))
    _b = field_validator("subject_box", "face_box", mode="before")(lambda cls, v: _box(v) if v else [])


def photo_value(d: AdPhotoScore) -> float:
    """One number to rank candidates by: the model's score, with the faults that ruin an advert weighed in."""
    v = d.score + 0.2 * (d.mood - 5)
    v -= 3.0 * d.garbled_text + 2.0 * (not d.hands_faces_ok) + 1.5 * (not d.copy_space_ok) + 1.0 * (not d.sharp)
    return round(max(0.0, min(10.0, v)), 2)


def photo_messages(img: Image.Image, idea: str, space: str) -> list[dict]:
    text = ("You choose photos for an advert. The photo was meant to show:\n" + idea.strip()[:1500]
            + f"\n\nThe layout needs: {space}\n\n"
            "Judge it like an art director: any garbled or fake text, letters or logos (fatal), natural hands, "
            "faces and bodies, the copy space the layout needs, how well the mood fits, and sharpness. Score it "
            "0-10 (8+ = use it). Also give the main subject's box and, if a person is visible, the face's box, "
            "each as [x0, y0, x1, y1] fractions of the width and height (0..1); [] when there is none.\n"
            'Reply as JSON {"score": 0-10, "garbled_text": bool, "hands_faces_ok": bool, "copy_space_ok": bool, '
            '"mood": 0-10, "sharp": bool, "issues": ["short phrase"], "subject_box": [..], "face_box": [..]}.')
    return [{"role": "system", "content": "You are a strict art director. Answer only with JSON."},
            {"role": "user", "content": text, "images": [b64(img)]}]


def score_photo(img: Image.Image, idea: str, space: str, model: str, tick=None) -> dict:
    try:
        res = chat_sync("vision", photo_messages(img, idea, space), schema=AdPhotoScore, temperature=0.1,
                        max_tokens=500, timeout=get_settings().vision_timeout_s, tick=tick, model=model)
    except LLMError as e:
        raise Unavailable(str(e) or "vision model unavailable") from e
    d: AdPhotoScore = res.data
    return {"score": photo_value(d), "raw": d.score, "issues": [i[:80] for i in d.issues[:5]],
            "subject_box": d.subject_box or None, "face_box": d.face_box or None, "by": "vision", "model": model}


def best(scores: dict[str, dict], order: list[str]) -> str | None:
    """The highest score; a tie goes to the earlier candidate."""
    ok = [g for g in order if g in scores]
    if not ok:
        return None
    return max(ok, key=lambda g: (scores[g].get("score") or 0, -order.index(g)))


# ---------------------------------------------------------------- the finished advert

class AdQA(BaseModel):
    score: float = 7.0
    overlap: bool = False
    legible: bool = True
    mood_ok: bool = True
    issues: list[str] = []

    _c = field_validator("score", mode="before")(lambda cls, v: _clamp10(v))


QA_PASS = 6.0


def qa_messages(img: Image.Image, headline: str) -> list[dict]:
    text = ("This is a finished social media advert. Its headline should read: "
            f"{' '.join((headline or '').split())!r}.\n"
            "Check it like a senior art director: does any text run over a face, a person or the product, or over "
            "other text (overlap)? Is every line easy to read (legible)? Does the photo's mood suit the message "
            "(mood_ok)? Score the whole advert 0-10 (7+ = ready to publish).\n"
            'Reply as JSON {"score": 0-10, "overlap": bool, "legible": bool, "mood_ok": bool, '
            '"issues": ["short phrase"]}.')
    return [{"role": "system", "content": "You review adverts before they go out. Answer only with JSON."},
            {"role": "user", "content": text, "images": [b64(img, 1024)]}]


def qa(img: Image.Image, headline: str, model: str, tick=None) -> dict:
    try:
        res = chat_sync("vision", qa_messages(img, headline), schema=AdQA, temperature=0.1, max_tokens=300,
                        timeout=get_settings().vision_timeout_s, tick=tick, model=model)
    except LLMError as e:
        raise Unavailable(str(e) or "vision model unavailable") from e
    d: AdQA = res.data
    score = d.score - 2.5 * d.overlap - 2.5 * (not d.legible) - 1.0 * (not d.mood_ok)
    score = round(max(0.0, min(10.0, score)), 2)
    return {"score": score, "pass": score >= QA_PASS and not d.overlap and d.legible,
            "issues": [i[:80] for i in d.issues[:5]], "by": "vision"}


def heuristic_qa(report: dict) -> dict:
    """The layout's own measurements as a QA verdict: the copy off the subject and every contrast check met."""
    q = report.get("quality") or {}
    overlap = (report.get("placement") or {}).get("overlap") or 0.0
    issues = []
    if overlap > 0.12:
        issues.append("copy over the subject")
    if q and not q.get("all_pass", True):
        issues.append("a contrast check failed")
    if (report.get("fit") or {}).get("trimmed"):
        issues.append("copy had to be trimmed")
    score = round(max(0.0, 9.0 - 20 * max(0.0, overlap - 0.04) - 2.5 * (len(issues) and not q.get("all_pass", True))
                      - 0.5 * bool((report.get("fit") or {}).get("trimmed"))), 2)
    return {"score": score, "pass": overlap <= 0.12 and q.get("all_pass", True), "issues": issues, "by": "heuristic"}


# ---------------------------------------------------------------- the brand's own adverts

SHAPES = ("blob", "arch", "circle", "teardrop", "rounded", "dots")
ENUMS = {"headline_weight": ("regular", "bold", "black"), "headline_case": ("upper", "title", "sentence"),
         "colour_usage": ("minimal", "balanced", "bold"), "background": ("photo", "light", "dark", "colour"),
         "density": ("airy", "balanced", "dense")}


def _enum(field: str):
    def check(cls, v):
        v = str(v or "").strip().lower()
        return v if v in ENUMS[field] else ""
    return field_validator(field, mode="before")(check)


class AdStyleRead(BaseModel):
    layout: str = ""
    shapes: list[str] = []
    headline_weight: str = ""
    headline_case: str = ""
    serif: bool = False
    colour_usage: str = ""
    background: str = ""
    density: str = ""
    badge: bool = False
    notes: str = Field("", max_length=400)

    @field_validator("layout", mode="before")
    @classmethod
    def _layout(cls, v):
        v = str(v or "").strip().lower().replace(" ", "_").replace("-", "_")
        return v if v in AD_LAYOUTS else ""

    @field_validator("shapes", mode="before")
    @classmethod
    def _shapes(cls, v):
        return [s for s in dict.fromkeys(str(x).strip().lower() for x in (v or [])) if s in SHAPES]

    @field_validator("notes", mode="before")
    @classmethod
    def _notes(cls, v):
        return " ".join(str(v or "").split())[:400]

    _w = _enum("headline_weight")
    _k = _enum("headline_case")
    _u = _enum("colour_usage")
    _g = _enum("background")
    _d = _enum("density")


def style_messages(img: Image.Image) -> list[dict]:
    menu = "\n".join(f"- {k}: {v}" for k, v in AD_LAYOUT_NOTES.items())
    text = ("This is one of a brand's own adverts. Describe its design system so new adverts can follow it.\n"
            f"Which of these layouts is it closest to?\n{menu}\n"
            f"shapes: any of {', '.join(SHAPES)} that it uses (organic blobs, arches, circles, teardrops, "
            "rounded cards, confetti dots). headline_weight: regular, bold or black. headline_case: upper, title or "
            "sentence. serif: is the headline a serif face? colour_usage: minimal, balanced or bold. background: "
            "photo, light, dark or colour. density: airy, balanced or dense. badge: is there a round price or "
            "discount badge? notes: one or two sentences in English on what makes it recognisable (no brand "
            "names, no text from the ad).\n"
            'Reply as JSON {"layout": "...", "shapes": [], "headline_weight": "...", "headline_case": "...", '
            '"serif": false, "colour_usage": "...", "background": "...", "density": "...", "badge": false, '
            '"notes": "..."}.')
    return [{"role": "system", "content": "You are a brand designer reverse-engineering a design system. "
                                          "Answer only with JSON."},
            {"role": "user", "content": text, "images": [b64(img, 1024)]}]


def read_style(img: Image.Image, model: str, tick=None) -> dict:
    try:
        res = chat_sync("vision", style_messages(img), schema=AdStyleRead, temperature=0.1, max_tokens=500,
                        timeout=get_settings().vision_timeout_s, tick=tick, model=model)
    except LLMError as e:
        raise Unavailable(str(e) or "vision model unavailable") from e
    return res.data.model_dump()


def _vote(values: list, default=""):
    values = [v for v in values if v not in ("", None)]
    if not values:
        return default
    counts = Counter(values)
    top = max(counts.values())
    return next(v for v in values if counts[v] == top)  # the first reference breaks a tie


MASK_OF = {"arch": "arch", "circle": "circle", "teardrop": "teardrop", "blob": "blob"}


def merge(reads: list[dict]) -> dict:
    """One set of rules from every reference's reading: majority per field, the first reference breaks ties."""
    layouts = Counter(r["layout"] for r in reads if r.get("layout"))
    ordered = sorted(layouts, key=lambda k: (-layouts[k], next(i for i, r in enumerate(reads) if r.get("layout") == k)))
    n = max(1, len(reads))
    pinned = bool(ordered) and len(ordered) <= 2 and sum(layouts.values()) >= 0.7 * n and n >= 2
    shapes = Counter(s for r in reads for s in r.get("shapes") or [])
    shape_list = [s for s, c in shapes.most_common() if c >= max(1, n / 3)]
    mask = next((MASK_OF[s] for s in shape_list if s in MASK_OF and s != "blob"), None)
    if mask is None and any(r.get("layout") in ("arch_mask", "circle_mask") for r in reads):
        mask = "circle" if layouts.get("circle_mask", 0) > layouts.get("arch_mask", 0) else "arch"
    notes = " ".join(dict.fromkeys(r["notes"] for r in reads if r.get("notes")))[:600]
    return {"layouts": ordered, "pinned": pinned, "mask": mask, "shapes": shape_list,
            "headline_weight": _vote([r.get("headline_weight") for r in reads]) or None,
            "headline_case": _vote([r.get("headline_case") for r in reads]) or None,
            "serif": sum(bool(r.get("serif")) for r in reads) * 2 > n,
            "colour_usage": _vote([r.get("colour_usage") for r in reads]) or None,
            "background": _vote([r.get("background") for r in reads]) or None,
            "density": _vote([r.get("density") for r in reads]) or None,
            "badge": sum(bool(r.get("badge")) for r in reads) * 2 >= n,
            "notes": notes, "references_read": len(reads)}


def summary(rules: dict | None) -> str:
    if not rules:
        return ""
    bits = []
    if rules.get("layouts"):
        bits.append(", ".join(x.replace("_", " ") for x in rules["layouts"][:3]))
    head = " ".join(x for x in (rules.get("headline_weight"), rules.get("headline_case")) if x)
    if head:
        bits.append(f"{head} headlines")
    if rules.get("serif"):
        bits.append("serif type")
    if rules.get("density"):
        bits.append(rules["density"])
    return "; ".join(bits)
