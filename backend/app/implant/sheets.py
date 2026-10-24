"""The consultation sheet and the surgical chart: one A4 page each, drawn with PIL and saved as PDF."""
import io
from pathlib import Path

from PIL import Image, ImageDraw

from app.config import get_settings
from app.implant import planning
from app.implant.service import (DISCLAIMER, PLACEMENT_WORDS, VIEWS, _font, patient_rel)
from app.models import Generation, ImplantPatient, utcnow

W, H = 1240, 1754  # A4 at 150 dpi
M = 70
INK, MUTED, LINE, BG = (31, 28, 24), (111, 103, 91), (221, 213, 198), (250, 248, 243)

MEASURES = [
    ("height_cm", "Height (cm)"), ("weight_kg", "Weight (kg)"), ("bra_size", "Current bra size"),
    ("chest_width_cm", "Chest width (cm)"), ("bw_left_cm", "Base width L (cm)"), ("bw_right_cm", "Base width R (cm)"),
    ("snn_left_cm", "Notch–nipple L (cm)"), ("snn_right_cm", "Notch–nipple R (cm)"),
    ("nimf_left_cm", "Nipple–fold L (cm)"), ("nimf_right_cm", "Nipple–fold R (cm)"),
    ("pinch_cm", "Upper-pole pinch (cm)"), ("ptosis_grade", "Ptosis grade (0–3)"), ("asymmetry", "Asymmetry"),
]
PROFILE_LABEL = {"low": "Low", "moderate": "Moderate", "moderate_plus": "Moderate plus", "high": "High",
                 "extra_high": "Extra high"}


def option_line(opt: dict) -> str:
    cc = f"{opt['left_cc']} cc" if opt["left_cc"] == opt["right_cc"] else f"L {opt['left_cc']} / R {opt['right_cc']} cc"
    return (f"{cc} · {PROFILE_LABEL.get(opt['profile'], opt['profile'])} profile · {opt['shape'].title()} · "
            f"{opt['placement'].replace('_', ' ')} · {opt.get('fill', 'silicone')}"
            + (" · with lift" if opt.get("procedure") == "augmentation_lift" else ""))


def _page():
    im = Image.new("RGB", (W, H), BG)
    return im, ImageDraw.Draw(im)


def _head(d, title: str, p: ImplantPatient, surgeon: str) -> int:
    d.text((M, M), title, font=_font("serif", 46), fill=INK)
    y = M + 70
    d.text((M, y), f"Patient {p.label}   ·   Surgeon {surgeon}   ·   {utcnow():%d %b %Y}", font=_font("inter", 22),
           fill=MUTED)
    y += 44
    d.line((M, y, W - M, y), fill=LINE, width=2)
    return y + 24


def _foot(d) -> None:
    d.line((M, H - M - 40, W - M, H - M - 40), fill=LINE, width=2)
    d.text((M, H - M - 24), DISCLAIMER, font=_font("inter", 20), fill=MUTED)


def _fit(path: Path, box: tuple[int, int]) -> Image.Image:
    with Image.open(path) as src:
        im = src.convert("RGB")
    im.thumbnail(box)
    return im


def _pairs(im, d, y: int, rows: list[tuple[str, Generation | None, list[tuple[str, Generation | None]]]],
           bottom: int) -> int:
    """One row per view: the photo, then each option's result, captioned."""
    root = get_settings().data_dir
    cols = 1 + max((len(r[2]) for r in rows), default=1)
    cw = (W - 2 * M - (cols - 1) * 16) // cols
    ch = min(int(cw * 1.25), (bottom - y) // max(1, len(rows)) - 40)
    for view, before, afters in rows:
        cells = [("Before · " + VIEWS.get(view, view), before)] + afters
        for i, (cap, g) in enumerate(cells):
            x = M + i * (cw + 16)
            d.rectangle((x, y, x + cw, y + ch), outline=LINE, width=2)
            if g is not None and g.file_path and (root / g.file_path).is_file():
                pic = _fit(root / g.file_path, (cw - 8, ch - 8))
                im.paste(pic, (x + (cw - pic.width) // 2, y + (ch - pic.height) // 2))
            d.text((x, y + ch + 6), cap[:48], font=_font("inter", 18), fill=MUTED)
        y += ch + 40
    return y


def _pdf(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PDF", resolution=150.0)
    return buf.getvalue()


def consultation(p: ImplantPatient, surgeon: str, photos: dict[str, Generation], options: list[dict],
                 results: list[Generation]) -> bytes:
    im, d = _page()
    y = _head(d, "Breast augmentation consultation", p, surgeon)
    for i, opt in enumerate(options):
        d.text((M, y), f"Option {chr(65 + i)}: {option_line(opt)}", font=_font("inter", 22), fill=INK)
        y += 32
        a = planning.assess(opt, p.measurements or {})
        d.text((M + 30, y), _dims(a), font=_font("inter", 18), fill=MUTED)
        y += 28
        for c in a["checks"][:2]:
            d.text((M + 30, y), ("! " if c["level"] == "warn" else "· ") + c["text"][:110], font=_font("inter", 17),
                   fill=MUTED)
            y += 26
    y += 12
    by: dict[str, dict[int, Generation]] = {}
    for g in results:
        imp = (g.params or {}).get("implant") or {}
        if g.status in ("ready", "approved"):
            by.setdefault(imp.get("view"), {})[imp.get("option")] = g
    rows = [(v, photos.get(v), [(f"Option {chr(65 + i)}", by.get(v, {}).get(i)) for i in range(len(options))])
            for v in VIEWS if v in photos]
    _pairs(im, d, y, rows, H - M - 70)
    _foot(d)
    return _pdf(im)


def chart(p: ImplantPatient, surgeon: str, photos: dict[str, Generation], opt: dict, picked: dict[str, Generation],
          notes: str) -> bytes:
    """The approved plan, for the patient file: measurements, implants per side, before/after, signatures."""
    im, d = _page()
    y = _head(d, "Surgical planning chart · breast augmentation", p, surgeon)
    f, fb = _font("inter", 21), _font("inter", 24)
    c = p.consent or {}
    d.text((M, y), f"Consent recorded {str(c.get('at', ''))[:10]} by {c.get('attested_by', '')}"
                   f"{' · signed form on file' if c.get('form_path') else ''}"
                   f" · 18+ confirmed: {'yes' if p.adult_confirmed else 'no'}", font=f, fill=MUTED)
    y += 44
    d.text((M, y), "Measurements", font=fb, fill=INK)
    y += 38
    m = p.measurements or {}
    half = (W - 2 * M) // 2
    for i, (key, label) in enumerate(MEASURES):
        x = M + (i % 2) * half
        val = m.get(key)
        d.text((x, y), f"{label}: {val if val not in (None, '') else '—'}", font=f, fill=INK)
        if i % 2:
            y += 32
    y += 48
    d.text((M, y), "Approved implants", font=fb, fill=INK)
    y += 38
    for side, cc in (("Left", opt["left_cc"]), ("Right", opt["right_cc"])):
        d.text((M, y), f"{side}: {cc} cc · {PROFILE_LABEL.get(opt['profile'], opt['profile'])} profile · "
                       f"{opt['shape'].title()} · {opt.get('fill', 'silicone').title()}", font=f, fill=INK)
        y += 32
    d.text((M, y), f"Placement: {PLACEMENT_WORDS[opt['placement']].split(',')[0].replace('placed ', '')}",
           font=f, fill=INK)
    y += 32
    a = planning.assess(opt, p.measurements or {})
    d.text((M, y), _dims(a), font=_font("inter", 19), fill=MUTED)
    y += 30
    for c in a["checks"][:3]:
        d.text((M, y), ("! " if c["level"] == "warn" else "· ") + c["text"][:115], font=_font("inter", 18), fill=INK)
        y += 28
    y += 14
    rows = [(v, photos.get(v), [("After · approved", picked.get(v))]) for v in VIEWS if v in photos]
    y = _pairs(im, d, y, rows, H - M - 330)
    d.text((M, y), "Surgeon's notes", font=fb, fill=INK)
    y += 36
    for line in _wrap(notes or "—", 95)[:5]:
        d.text((M, y), line, font=f, fill=INK)
        y += 30
    y = max(y + 30, H - M - 150)
    for i, label in enumerate(("Surgeon signature", "Patient signature", "Date")):
        x = M + i * ((W - 2 * M) // 3)
        d.line((x, y, x + (W - 2 * M) // 3 - 30, y), fill=INK, width=2)
        d.text((x, y + 8), label, font=_font("inter", 18), fill=MUTED)
    _foot(d)
    return _pdf(im)


def _dims(a: dict) -> str:
    def side(s: dict) -> str:
        cup = f" (to {s['target_cup']})" if s.get("target_cup") else ""
        return f"≈{s['width_cm']} cm wide, {s['projection_cm']} cm projection, +{s['cup_change']:g} cup{cup}"

    left, right = a["sides"]["left"], a["sides"]["right"]
    text = side(left) if left == right else f"L {side(left)} · R {side(right)}"
    return text + " (approximate; confirm with the manufacturer's chart)"


def save_chart(p: ImplantPatient, data: bytes, version: int) -> str:
    rel = patient_rel(p) / "charts" / f"chart_v{version}.pdf"
    dest = get_settings().data_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return rel.as_posix()


def _wrap(text: str, width: int) -> list[str]:
    out, line = [], ""
    for word in text.split():
        if len(line) + len(word) + 1 > width:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    return out + ([line] if line else [])
