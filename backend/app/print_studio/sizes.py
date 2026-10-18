"""Print sizes (contract v41): centimetres, dpi and bleed to pixels, the size presets, how far away the
letters must read, and which layout family a shape gets."""
from dataclasses import dataclass

MM_PER_INCH = 25.4
JOBS = ("sign", "board", "flyer", "sticker")
JOB_LABELS = {"sign": "Shop sign", "board": "Poster / board", "flyer": "Flyer / menu", "sticker": "Window sticker"}
DPIS = (100, 150, 200, 300)
DEFAULT_DPI = {"sign": 150, "board": 150, "flyer": 300, "sticker": 300}
DEFAULT_BLEED_MM = 3.0
SLUG_MM = 10.0  # the PDF's margin outside the bleed, where the crop marks go

# metres the copy has to read from; the smallest letters follow from it
DISTANCES = {"near": 0.6, "street": 5.0, "road": 20.0}
DISTANCE_LABELS = {"near": "Close up (counter, door, hand)", "street": "Street (across the pavement)",
                   "road": "Road (from a passing car)"}
DEFAULT_DISTANCE = {"sign": "street", "board": "street", "flyer": "near", "sticker": "near"}

# beyond this a single raster gets silly (a 106 x 160 cm board at 300 dpi is 240 MP); the shop's RIP scales
MAX_MP = 160.0
MIN_CM, MAX_CM = 3.0, 500.0

PRESETS = (
    {"id": "sign-25x70", "label": "Shop sign 25 × 70 cm", "job": "sign", "width_cm": 25, "height_cm": 70},
    {"id": "sign-70x25", "label": "Fascia sign 70 × 25 cm", "job": "sign", "width_cm": 70, "height_cm": 25},
    {"id": "poster-50x70", "label": "Poster 50 × 70 cm", "job": "board", "width_cm": 50, "height_cm": 70},
    {"id": "poster-70x100", "label": "Poster 70 × 100 cm", "job": "board", "width_cm": 70, "height_cm": 100},
    {"id": "board-106x160", "label": "Board 106 × 160 cm", "job": "board", "width_cm": 106, "height_cm": 160},
    {"id": "a5", "label": "A5 flyer", "job": "flyer", "width_cm": 14.8, "height_cm": 21},
    {"id": "a4", "label": "A4 flyer / menu", "job": "flyer", "width_cm": 21, "height_cm": 29.7},
    {"id": "a3", "label": "A3 poster", "job": "flyer", "width_cm": 29.7, "height_cm": 42},
    {"id": "sticker-round-10", "label": "Round sticker Ø 10 cm", "job": "sticker", "width_cm": 10, "height_cm": 10,
     "shape": "round"},
    {"id": "sticker-30x10", "label": "Window sticker 30 × 10 cm", "job": "sticker", "width_cm": 30, "height_cm": 10},
)


def px(mm: float, dpi: int) -> int:
    return max(1, round(mm * dpi / MM_PER_INCH))


@dataclass(frozen=True)
class Canvas:
    width_mm: float
    height_mm: float
    bleed_mm: float = DEFAULT_BLEED_MM
    dpi: int = 150

    @property
    def full_mm(self) -> tuple[float, float]:
        return self.width_mm + 2 * self.bleed_mm, self.height_mm + 2 * self.bleed_mm

    @property
    def k(self) -> float:
        """Pixels per millimetre at print size."""
        return self.dpi / MM_PER_INCH

    @property
    def size_px(self) -> tuple[int, int]:
        fw, fh = self.full_mm
        return px(fw, self.dpi), px(fh, self.dpi)

    @property
    def trim_px(self) -> tuple[int, int]:
        return px(self.width_mm, self.dpi), px(self.height_mm, self.dpi)

    @property
    def bleed_px(self) -> int:
        return round(self.bleed_mm * self.k)

    @property
    def megapixels(self) -> float:
        w, h = self.size_px
        return w * h / 1e6

    def label(self) -> str:
        # the trim in pixels, as a print shop quotes it; the file itself is the bleed larger
        w, h = self.trim_px
        return f"{cm(self.width_mm)} × {cm(self.height_mm)} cm · {self.dpi} dpi · {w} × {h} px"


def cm(mm: float) -> str:
    v = round(mm / 10, 1)
    return f"{v:g}"


def canvas(width_cm: float, height_cm: float, dpi: int = 150, bleed_mm: float = DEFAULT_BLEED_MM) -> Canvas:
    return Canvas(float(width_cm) * 10, float(height_cm) * 10, float(bleed_mm), int(dpi))


def too_big(c: Canvas) -> bool:
    return c.megapixels > MAX_MP


def best_dpi(width_cm: float, height_cm: float, want: int, bleed_mm: float = DEFAULT_BLEED_MM) -> int:
    """The asked-for dpi, or the highest offered one that stays under MAX_MP."""
    for d in sorted((x for x in DPIS if x <= want), reverse=True):
        if not too_big(canvas(width_cm, height_cm, d, bleed_mm)):
            return d
    return DPIS[0]


def min_cap_mm(distance: str) -> float:
    """The smallest capital height that still reads from the viewing distance: about 3 mm a metre (roughly an
    inch per 28 feet, the legible end of the signage rule of thumb), never under 1.5 mm (7-8 pt) close up."""
    return round(max(1.5, DISTANCES.get(distance, DISTANCES["street"]) * 3.0), 1)


def hero_cap_mm(distance: str) -> float:
    # what the hero line aims for when the space allows: the "inch per 10 feet" end of the rule
    return round(max(6.0, DISTANCES.get(distance, DISTANCES["street"]) * 8.0), 1)


def family(job: str, width: float, height: float) -> str:
    """wide (fascia), tall (board, blade sign), square-ish, or sheet (flyer and menu, whatever the shape)."""
    if job == "flyer":
        return "sheet"
    r = width / max(height, 1e-6)
    if r >= 1.3:
        return "wide"
    if r <= 0.77:
        return "tall"
    return "square"
