"""Brand kit request/response shapes (contract v7).

Separate from app.schemas so the compositing code can import the settings model without pulling in
the whole API surface.
"""
import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas import JobOut, MediaItemOut, Utc

HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")


def norm_hex(v: str) -> str:
    m = HEX.match((v or "").strip())
    if not m:
        raise ValueError(f"'{v}' isn't a #RRGGBB colour")
    return "#" + m[1].upper()


# ---------------------------------------------------------------- output-time settings

class WatermarkSettings(BaseModel):
    enabled: bool = False
    position: Literal["tl", "tr", "bl", "br"] = "br"
    # the logo's longer side as a % of the frame's short side
    size_pct: float = Field(12.0, ge=2, le=50)
    opacity: float = Field(0.85, ge=0.05, le=1)
    margin_pct: float = Field(3.0, ge=0, le=20)
    variant: Literal["auto", "primary", "light", "dark"] = "auto"


Background = int | str | None  # palette index, "#RRGGBB", or None for the first palette colour


class CardSettings(BaseModel):
    enabled: bool = False
    duration_s: float = Field(2.5, ge=1, le=8)
    bg: Background = None
    show_tagline: bool = True
    show_name: bool = False


class LowerThirdSettings(BaseModel):
    enabled: bool = False
    at_s: float = Field(1.0, ge=0)
    duration_s: float = Field(4.0, ge=1, le=30)
    text: str | None = Field(None, max_length=120)
    subtext: str | None = Field(None, max_length=160)


class GradeSettings(BaseModel):
    enabled: bool = False
    strength: float = Field(0.25, ge=0, le=1)


def _intro_default() -> CardSettings:
    return CardSettings(duration_s=2.0, show_tagline=False, show_name=True)


class BrandSettings(BaseModel):
    """All post-processing extras. Everything is off by default (PLAN-m8 B2: the logo belongs inside
    the scenes; these are optional add-ons)."""
    watermark: WatermarkSettings = WatermarkSettings()
    end_card: CardSettings = CardSettings()
    intro_card: CardSettings = Field(default_factory=_intro_default)
    lower_third: LowerThirdSettings = LowerThirdSettings()
    grade: GradeSettings = GradeSettings()
    # how an advert planned with this kit ends (brand_moments.closing_mode); "none" plans no closing shot
    closing: Literal["auto", "ai_packshot", "logo_reveal", "none"] = "auto"

    def enabled(self) -> list[str]:
        return [k for k in ("watermark", "intro_card", "end_card", "lower_third", "grade") if getattr(self, k).enabled]


def merged_settings(base: dict | None, override: dict | None = None) -> BrandSettings:
    """Kit settings with per-call overrides on top (one level deep per section)."""
    # start from the defaults section by section: the intro card's own defaults differ from CardSettings'
    data = BrandSettings().model_dump()
    for k, v in (base or {}).items():
        if isinstance(v, dict) and isinstance(data.get(k), dict):
            data[k].update(v)
        elif k in data and not isinstance(data[k], dict):
            data[k] = v
    for k, v in (override or {}).items():
        if k not in data:
            continue
        if not isinstance(data[k], dict):
            data[k] = v  # scalar settings (closing) replace outright
        elif isinstance(v, bool):
            data[k]["enabled"] = v
        elif isinstance(v, dict):
            data[k].update(v)
    return BrandSettings.model_validate(data)


# ---------------------------------------------------------------- kit

class PaletteColour(BaseModel):
    hex: str
    name: str | None = Field(None, max_length=60)

    @field_validator("hex")
    @classmethod
    def _hex(cls, v):
        return norm_hex(v)


class LogoRef(BaseModel):
    media_id: str
    description: str = Field("", max_length=300)


class Logos(BaseModel):
    primary: LogoRef | None = None
    light: LogoRef | None = None
    dark: LogoRef | None = None


class Product(BaseModel):
    media_id: str
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=300)


class BrandKitIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    is_default: bool = False
    palette: list[PaletteColour] = Field([], max_length=8)
    style_text: str = Field("", max_length=2000)
    voice_text: str = Field("", max_length=2000)
    tagline: str = Field("", max_length=300)
    logos: Logos = Logos()
    products: list[Product] = Field([], max_length=12)
    font_files: list[str] = Field([], max_length=4)
    reference_media_ids: list[str] = Field([], max_length=6)
    settings: dict[str, Any] = {}


class BrandKitPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    palette: list[PaletteColour] | None = Field(None, max_length=8)
    style_text: str | None = Field(None, max_length=2000)
    voice_text: str | None = Field(None, max_length=2000)
    tagline: str | None = Field(None, max_length=300)
    logos: Logos | None = None
    products: list[Product] | None = Field(None, max_length=12)
    font_files: list[str] | None = Field(None, max_length=4)
    reference_media_ids: list[str] | None = Field(None, max_length=6)
    settings: dict[str, Any] | None = None


class AssetOut(BaseModel):
    media_id: str
    kind: str | None = None
    media_url: str | None = None
    missing: bool = False


class BrandKitOut(BaseModel):
    id: str
    workspace_id: str
    name: str
    is_default: bool
    palette: list[dict[str, Any]]
    style_text: str
    voice_text: str
    tagline: str
    logos: dict[str, Any]
    products: list[dict[str, Any]]
    font_files: list[str]
    reference_media_ids: list[str]
    settings: BrandSettings
    assets: dict[str, AssetOut] = {}
    prompt_context: str = ""
    created_at: Utc
    updated_at: Utc


class BrandPreviewIn(BaseModel):
    kind: Literal["image", "end_card", "intro_card", "lower_third"] = "image"
    sample_media_id: str | None = None
    # unsaved editor changes, merged over the kit's settings
    settings: dict[str, Any] | None = None


class BrandApplyIn(BaseModel):
    kit_id: str | None = None
    # per-call overrides: {"watermark": true} or {"end_card": {"enabled": true, "duration_s": 3}}
    options: dict[str, Any] | None = None


class RevealBackground(BaseModel):
    kind: Literal["color", "image"] = "color"
    color: int | str | None = None
    media_id: str | None = None


class LogoRevealIn(BaseModel):
    duration_s: float = Field(3.0, ge=1.5, le=10)
    aspect: Literal["16:9", "9:16", "1:1", "4:5"] = "16:9"
    background: RevealBackground = RevealBackground()
    show_tagline: bool = True
    title: str | None = Field(None, max_length=300)


class LogoRevealOut(BaseModel):
    item: MediaItemOut
    job: JobOut


class ProjectBrandIn(BaseModel):
    kit_id: str | None = None
