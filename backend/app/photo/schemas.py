"""Request/response models for Photo Studio (contract v9). Kept here rather than in app/schemas.py."""
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas import Utc


def _s(lo: float = -100, hi: float = 100):
    return Field(0, ge=lo, le=hi)


class _Loose(BaseModel):
    # unknown keys are ignored so an older or newer client never gets a 422 for an extra field
    model_config = ConfigDict(extra="ignore")


class Curve(_Loose):
    blacks: float = _s()
    shadows: float = _s()
    mids: float = _s()
    highlights: float = _s()
    whites: float = _s()


class HslBand(_Loose):
    h: float = _s()
    s: float = _s()
    l: float = _s()  # noqa: E741  (the NoorViz key)


class Hsl(_Loose):
    red: HslBand = HslBand()
    orange: HslBand = HslBand()
    yellow: HslBand = HslBand()
    green: HslBand = HslBand()
    aqua: HslBand = HslBand()
    blue: HslBand = HslBand()
    purple: HslBand = HslBand()
    magenta: HslBand = HslBand()


class Crop(_Loose):
    x: float = Field(0, ge=0)
    y: float = Field(0, ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class LightPoint(_Loose):
    x: float
    y: float
    exposure: float = _s()
    falloff: float | None = Field(None, gt=0)
    refW: float | None = Field(None, gt=0)  # noqa: N815
    refH: float | None = Field(None, gt=0)  # noqa: N815


class PaletteEntry(_Loose):
    centerR: float = Field(ge=0, le=255)  # noqa: N815
    centerG: float = Field(ge=0, le=255)  # noqa: N815
    centerB: float = Field(ge=0, le=255)  # noqa: N815
    enabled: bool = True
    h: float = _s()
    s: float = _s()
    l: float = _s()  # noqa: E741


class LutRef(_Loose):
    look_id: str = Field(min_length=1, max_length=36)
    amount: float = Field(100, ge=0, le=100)


class DevelopParams(_Loose):
    version: int = 1
    exposure: float = _s()
    contrast: float = _s()
    highlights: float = _s()
    shadows: float = _s()
    whites: float = _s()
    blacks: float = _s()
    temperature: float = _s()
    tint: float = _s()
    vibrance: float = _s()
    saturation: float = _s()
    clarity: float = _s()
    sharpness: float = _s(0, 100)
    noiseReduction: float = _s(0, 100)  # noqa: N815
    vignette: float = _s()
    curve: Curve = Curve()
    hsl: Hsl = Hsl()
    crop: Crop | None = None
    rotate: float = _s(-180, 180)
    flipH: bool = False  # noqa: N815
    flipV: bool = False  # noqa: N815
    lightPoints: list[LightPoint] = Field(default_factory=list, max_length=16)  # noqa: N815
    palette: list[PaletteEntry] = Field(default_factory=list, max_length=16)
    lut: LutRef | None = None

    def plain(self) -> dict:
        return self.model_dump(exclude_none=False)


Format = Literal["jpeg", "png", "png16", "tiff16"]
EffectName = Literal["deyellow", "pop", "bw", "sepia", "warm", "cool", "soften_skin", "denoise", "auto_restore"]


class PreviewIn(BaseModel):
    params: DevelopParams = DevelopParams()
    max_side: int = Field(1280, ge=64, le=2560)


class ParamsIn(BaseModel):
    params: DevelopParams = DevelopParams()


class RenderIn(BaseModel):
    params: DevelopParams = DevelopParams()
    format: Format = "jpeg"
    quality: int = Field(95, ge=60, le=100)
    note: str | None = Field(None, max_length=2000)


class EffectIn(BaseModel):
    name: EffectName
    strength: float = Field(1.0, ge=0, le=1)
    format: Format = "jpeg"
    quality: int = Field(95, ge=60, le=100)
    note: str | None = Field(None, max_length=2000)


class CubeIn(BaseModel):
    params: DevelopParams = DevelopParams()
    size: int = Field(33, ge=2, le=65)
    title: str = Field("", max_length=120)


class LookIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    params: DevelopParams = DevelopParams()
    description: str = Field("", max_length=2000)
    category: str = Field("", max_length=80)
    generation_id: str | None = None


class LookPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    params: DevelopParams | None = None
    description: str | None = Field(None, max_length=2000)
    category: str | None = Field(None, max_length=80)


class ApplyVideoIn(BaseModel):
    generation_id: str = Field(min_length=1, max_length=36)
    intensity: float = Field(1.0, ge=0, le=1)


class LookOut(BaseModel):
    id: str
    name: str
    description: str
    category: str
    source: str
    params: dict[str, Any]
    has_cube: bool
    cube_size: int | None = None
    editable: bool
    spatial: list[str]
    thumb_url: str
    created_at: Utc
    updated_at: Utc


class ImportReport(BaseModel):
    file: str
    ok: bool
    kind: str | None = None
    look_id: str | None = None
    name: str | None = None
    cube_size: int | None = None
    mapped: list[str] = []
    unmapped: list[str] = []
    notes: list[str] = []
    error: str | None = None


class ImportOut(BaseModel):
    looks: list[LookOut]
    reports: list[ImportReport]

