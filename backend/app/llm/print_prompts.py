"""Print Studio prompts (contract v41): the creative director for signs, boards, flyers and stickers. Kept apart
from prompts.py; the copy check and the guard are Ad Studio's."""
import re

from pydantic import BaseModel, Field, field_validator

from app import aerab

PRINT_FAMILIES = ("typographic", "photo", "illustration")
PRINT_FONTS = ("bold", "condensed", "impact", "modern", "friendly", "elegant")
PRINT_DECOR = ("none", "awning", "frame")
_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")

FAMILY_NOTES = {
    "typographic": "type only: the name, colour and a strong contrast pair do all the work (no picture)",
    "photo": "a large photograph carries the board; type on solid colour beside or under it",
    "illustration": "a flat, simple illustration as the emblem next to the name (made on a plain white ground)",
}


class PrintConcept(BaseModel):
    insight: str = ""
    family: str = "typographic"
    layout: str = ""
    hero: str = "name"
    headline: str = ""
    cta: str = ""
    offers: list[str] = []
    ground: str = ""
    ink: str = ""
    accent: str = ""
    font: str = "bold"
    caps: bool = True
    decor: str = "none"
    photo_prompt: str = ""
    art_prompt: str = ""

    @field_validator("family")
    @classmethod
    def _family(cls, v):
        v = (v or "").strip().lower()
        return v if v in PRINT_FAMILIES else "typographic"

    @field_validator("hero")
    @classmethod
    def _hero(cls, v):
        return "headline" if (v or "").strip().lower() == "headline" else "name"

    @field_validator("font")
    @classmethod
    def _font(cls, v):
        v = (v or "").strip().lower()
        return v if v in PRINT_FONTS else "bold"

    @field_validator("decor")
    @classmethod
    def _decor(cls, v):
        v = (v or "").strip().lower()
        return v if v in PRINT_DECOR else "none"

    @field_validator("ground", "ink", "accent")
    @classmethod
    def _hex(cls, v):
        v = (v or "").strip()
        return v.upper() if _HEX.match(v) else ""

    @field_validator("caps", mode="before")
    @classmethod
    def _caps(cls, v):
        if isinstance(v, str):
            return v.strip().lower() in ("true", "yes", "1")
        return bool(v) if v is not None else True


class PrintConcepts(BaseModel):
    concepts: list[PrintConcept] = Field(min_length=1)


PRINT_RULES = """Signage rules:
- Few words. A sign is read in two seconds from {distance}: the shop's name and one hero line at most, then
  the practical lines (hours, phone). Never a paragraph.
- headline: an optional hero line of 2 to 5 words in {language}, everyday spoken idiom ("Färskt varje dag",
  "Fresh every morning"), never a translated English slogan. Leave it "" when the name and the owner's own lines
  already say it; a small shop sign is usually better without one.
- hero: "name" when the shop's name is the biggest thing (almost always on a sign), "headline" only on a board
  whose job is the message.
- cta: optional, 1 to 3 words for a board or flyer ("Välkommen in!"), "" on a sign.
- The owner's own lines (name, tagline, offers, hours, phone, address, website) are set exactly as written by
  the layout: never rewrite, translate or repeat them in your headline. Never write a price, a number, a
  phone number, an opening time or an address of your own.
- offers: only lines copied exactly from the owner's offers, the ones that suit this design (none on a sign
  unless the owner asked for them).
- Colours (ground, ink, accent as #RRGGBB): one strong contrast pair, ink on ground at least 7:1, readable in
  sunlight and at a glance; the accent for the band and the details. Prefer colours that print well (not neon
  screen greens and blues). Use what customers of this kind of business recognise: {knowledge}
- font: one of bold (Archivo Black), condensed (Bebas Neue caps), impact (Anton), modern (Montserrat),
  friendly (Poppins), elegant (Playfair). caps: true to set the name in capitals. A board or sign wants a heavy
  display face (bold, condensed, impact or friendly); friendly suits a rounded badge logo.
- layout logo_hero, where it is offered: the brand's logo is the headline, big and centred, the name small
  under it; the other lines as usual.
- decor: none, awning (shop-front stripes along the top) or frame (a border line).
- Every design is a different idea: a different colour pair, type and feel."""

KNOWLEDGE_HINT = ("a grocery or mini market (livs): fresh greens, warm yellows, tomato red, and the words its "
                  "customers look for (\"Öppet alla dagar\", \"Färska varor\", \"Frukt & Grönt\"); a bakery: warm "
                  "browns and cream; a pharmacy: green and white; a barber: black, white and a red stripe; a "
                  "restaurant or kebab shop: deep red, warm orange and charcoal. Apply what you know about this "
                  "kind of business in this market.")

PICTURE_RULES = """Pictures:
- photo (photo designs only, in English, 40 to 70 words): a bright, clean commercial photograph of what the
  shop sells or its best moment (e.g. a crate of fresh fruit and vegetables in morning light), shot close and
  full of colour, a simple calm background, the subject filling the frame. No people unless the business is
  about them. No text, letters, numbers, signs, logos or price tags anywhere.
- art_prompt (illustration designs only, in English, 15 to 30 words): one flat vector-style illustration that
  stands for the shop (e.g. a basket of fruit and vegetables, a loaf and wheat), bold simple shapes, no text."""


def print_concept_messages(*, job: str, job_label: str, shape: str, size_label: str, distance_label: str,
                           business_type: str, lines: dict, language: str, market: str, style: str, brand: str,
                           palette_words: list[str], families: list[str], layouts: dict[str, list[str]],
                           avoid: list[str] | None = None, has_photos: bool = False) -> list[dict]:
    lang_name = aerab.NAMES.get(language, language)
    owner = "\n".join(f"- {k}: {v}" for k, v in lines.items() if v and k != "offers")
    offers = [o for o in lines.get("offers") or [] if o]
    plan = "\n".join(f"Design {i}: {f}, {FAMILY_NOTES[f]}; layout one of {', '.join(layouts.get(f) or [])}"
                     for i, f in enumerate(families, 1))
    parts = [f"Design {len(families)} print option{'s' if len(families) > 1 else ''} for a {job_label.lower()} "
             f"({size_label}, a {shape} shape) for this business.",
             f"Kind of business: {business_type}" if business_type else "",
             f"The owner's lines, set exactly as written:\n{owner}" if owner else "",
             ("The owner's offers (copy exactly or leave out):\n" + "\n".join(f"- {o}" for o in offers))
             if offers else "Offers: none. Don't mention any price or deal.",
             f"The owner's style wishes: {style}" if style else "",
             f"The brand:\n{brand}" if brand else "",
             ("Brand colours to build on: " + ", ".join(palette_words)) if palette_words else "",
             "The owner supplied their own photos; photo designs use those." if has_photos else "",
             ("Already made, do something different from: " + " | ".join(avoid)) if avoid else "",
             "The plan, one entry per design, in this order:\n" + plan,
             PRINT_RULES.format(distance=distance_label.lower(), language=lang_name, knowledge=KNOWLEDGE_HINT),
             PICTURE_RULES]
    rule = aerab.writing_rule(language)
    if rule:
        parts.append(rule + " This applies to the headline and cta you write.")
    parts.append('Answer as JSON {"concepts": [{"insight": "...", "family": "typographic", "layout": "...", '
                 '"hero": "name", "headline": "", "cta": "", "offers": [], "ground": "#FFFFFF", "ink": "#1B1B1B", '
                 '"accent": "#2E7D32", "font": "bold", "caps": true, "decor": "none", "photo_prompt": "", '
                 f'"art_prompt": ""}}]}} with exactly {len(families)} concepts, family as in the plan.')
    return [{"role": "system", "content": "You are a senior sign maker and print designer in "
                                          f"{market or 'the target market'}, fluent in {lang_name}. "
                                          "Answer only with JSON."},
            {"role": "user", "content": "\n\n".join(p for p in parts if p)}]


PRINT_PHOTO_LOOK = "Bright, clean commercial photograph, natural daylight, rich true colours, crisp detail."
PRINT_ART_LOOK = ("Flat vector-style illustration, bold simple shapes, clean even outlines, a few solid colours, "
                  "centred with room around it, isolated on a plain pure white background, no shadow on the ground.")
PRINT_NO_TEXT = "No text, no letters, no numbers, no logos, no signs, no price tags anywhere in the picture."
