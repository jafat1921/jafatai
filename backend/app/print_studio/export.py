"""Print files from a scene (contract v41): PDF, PNG, JPG, an editable SVG and a ZIP of layer PNGs.

The PDF is written here rather than by Pillow's PDF plugin, which can only make a page the size of the picture:
a print shop wants the TrimBox and BleedBox set, the crop marks in the slug outside the bleed (vector lines in
registration colour), and nothing in the content but the artwork. The artwork itself is Pillow's JPEG at quality
95 without chroma subsampling, tagged sRGB. Page 2 is a small proof with the size and colour notes.

No CMYK conversion: the shop's RIP does that with its own profile. The gamut notes say which colours will dull.
"""
import base64
import io
import json
import time
import zipfile
from dataclasses import dataclass
from html import escape
from pathlib import Path

from PIL import Image, ImageDraw

from app.ads import icons
from app.ads import layout as lay
from app.print_studio import fonts as pf
from app.print_studio import raster
from app.print_studio import sizes as sz
from app.print_studio.layout import Assets, Scene

PT_PER_MM = 72 / 25.4
FORMATS = ("pdf", "png", "jpg", "svg", "zip")
MEDIA = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "svg": "image/svg+xml",
         "zip": "application/zip"}


def srgb_icc() -> bytes | None:
    from app.photo.develop import srgb_icc as icc

    return icc()


# ---------------------------------------------------------------- PDF

@dataclass
class Page:
    w_pt: float
    h_pt: float
    jpeg: bytes
    img_px: tuple[int, int]
    place: tuple[float, float, float, float]  # x, y, w, h in points, origin bottom left
    boxes: dict | None = None  # TrimBox / BleedBox: (x0, y0, x1, y1) points
    ops: str = ""  # extra content drawn over the artwork (crop marks, slug text)


class _Pdf:
    def __init__(self):
        self.objs: list[bytes | None] = []

    def reserve(self) -> int:
        self.objs.append(None)
        return len(self.objs)

    def put(self, n: int, body: bytes) -> int:
        self.objs[n - 1] = body
        return n

    def add(self, body: bytes) -> int:
        return self.put(self.reserve(), body)

    def stream(self, head: str, data: bytes) -> int:
        return self.add(f"<< {head} /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream")

    def bytes(self, root: int, info: int) -> bytes:
        out = io.BytesIO()
        out.write(b"%PDF-1.6\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for i, body in enumerate(self.objs, 1):
            offsets.append(out.tell())
            out.write(f"{i} 0 obj\n".encode() + (body or b"null") + b"\nendobj\n")
        xref = out.tell()
        out.write(f"xref\n0 {len(self.objs) + 1}\n0000000000 65535 f \n".encode())
        for o in offsets:
            out.write(f"{o:010d} 00000 n \n".encode())
        out.write(f"trailer\n<< /Size {len(self.objs) + 1} /Root {root} 0 R /Info {info} 0 R >>\n"
                  f"startxref\n{xref}\n%%EOF\n".encode())
        return out.getvalue()


def _n(v: float) -> str:
    return f"{v:.3f}".rstrip("0").rstrip(".")


def pdf_text(s: str) -> str:
    raw = s.encode("cp1252", "ignore").decode("cp1252")
    return raw.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def write_pdf(pages: list[Page], title: str = "") -> bytes:
    pdf = _Pdf()
    catalog, pages_n = pdf.reserve(), pdf.reserve()
    icc = srgb_icc()
    cs = f"[/ICCBased {pdf.stream('/N 3 /Alternate /DeviceRGB', icc)} 0 R]" if icc else "/DeviceRGB"
    font = pdf.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    kids = []
    for i, p in enumerate(pages):
        im = pdf.stream(f"/Type /XObject /Subtype /Image /Width {p.img_px[0]} /Height {p.img_px[1]} "
                        f"/ColorSpace {cs} /BitsPerComponent 8 /Filter /DCTDecode", p.jpeg)
        x, y, w, h = p.place
        content = f"q {_n(w)} 0 0 {_n(h)} {_n(x)} {_n(y)} cm /Im{i} Do Q\n{p.ops}".encode("cp1252", "replace")
        cn = pdf.stream("", content)
        boxes = "".join(f" /{k} [{' '.join(_n(v) for v in b)}]" for k, b in (p.boxes or {}).items())
        kids.append(pdf.add(f"<< /Type /Page /Parent {pages_n} 0 R /MediaBox [0 0 {_n(p.w_pt)} {_n(p.h_pt)}]{boxes} "
                            f"/Resources << /XObject << /Im{i} {im} 0 R >> /Font << /F1 {font} 0 R >> >> "
                            f"/Contents {cn} 0 R >>".encode()))
    pdf.put(pages_n, f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode())
    pdf.put(catalog, f"<< /Type /Catalog /Pages {pages_n} 0 R >>".encode())
    # the title as UTF-16, so a Swedish or Urdu name survives
    name = title.encode("utf-16-be").hex().upper()
    info = pdf.add(f"<< /Title <FEFF{name}> /Producer (Mix AI Print Studio) >>".encode())
    return pdf.bytes(catalog, info)


def crop_marks(trim: tuple[float, float, float, float], bleed_pt: float, length_pt: float) -> str:
    """Corner marks in the slug, starting just outside the bleed so none of them touch the artwork."""
    x0, y0, x1, y1 = trim
    gap = bleed_pt + 2.0
    ops = ["q 0.25 w 1 1 1 1 K"]
    for x, sx in ((x0, -1), (x1, 1)):
        for y, sy in ((y0, -1), (y1, 1)):
            ops.append(f"{_n(x + sx * gap)} {_n(y)} m {_n(x + sx * (gap + length_pt))} {_n(y)} l S")
            ops.append(f"{_n(x)} {_n(y + sy * gap)} m {_n(x)} {_n(y + sy * (gap + length_pt))} l S")
    ops.append("Q")
    return "\n".join(ops) + "\n"


def jpeg(img: Image.Image, dpi: int, quality: int = 95) -> bytes:
    buf = io.BytesIO()
    kw = {"quality": quality, "subsampling": 0, "dpi": (dpi, dpi), "optimize": False}
    icc = srgb_icc()
    if icc:
        kw["icc_profile"] = icc
    img.convert("RGB").save(buf, "JPEG", **kw)
    return buf.getvalue()


def print_pdf(art_jpeg: bytes, art_px: tuple[int, int], c: sz.Canvas, proof: Image.Image, title: str) -> bytes:
    slug = max(sz.SLUG_MM, c.bleed_mm + 7.0)
    fw, fh = c.full_mm
    w_pt, h_pt = (fw + 2 * slug) * PT_PER_MM, (fh + 2 * slug) * PT_PER_MM
    s, b = slug * PT_PER_MM, c.bleed_mm * PT_PER_MM
    bleed = (s, s, s + fw * PT_PER_MM, s + fh * PT_PER_MM)
    trim = (s + b, s + b, s + b + c.width_mm * PT_PER_MM, s + b + c.height_mm * PT_PER_MM)
    note = (f"{title} | trim {_n(c.width_mm)} x {_n(c.height_mm)} mm | bleed {_n(c.bleed_mm)} mm | {c.dpi} dpi | "
            f"sRGB, no CMYK conversion")
    ops = crop_marks(trim, b, 5 * PT_PER_MM)
    ops += f"BT /F1 6 Tf 0 g {_n(trim[0])} {_n(max(2.0, s * 0.3))} Td ({pdf_text(note)}) Tj ET\n"
    page1 = Page(w_pt, h_pt, art_jpeg, art_px, (s, s, fw * PT_PER_MM, fh * PT_PER_MM),
                 {"BleedBox": bleed, "TrimBox": trim, "CropBox": (0, 0, w_pt, h_pt)}, ops)
    pw, ph = proof.size
    # the proof at 150 ppi: A4-ish whatever the artwork
    page2 = Page(pw * 72 / 150, ph * 72 / 150, jpeg(proof, 150, 90), proof.size, (0, 0, pw * 72 / 150, ph * 72 / 150))
    return write_pdf([page1, page2], title)


def proof_sheet(scene: Scene, preview: Image.Image, title: str) -> Image.Image:
    """Page 2: the design with its trim and safe lines, and the notes a print shop asks about."""
    W, H = 1754, 1240  # A4 landscape at 150 ppi
    sheet = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(sheet)
    pad = 70
    box_w, box_h = W * 0.56 - pad, H - 2 * pad
    pv = preview.copy()
    pv.thumbnail((int(box_w), int(box_h)), Image.LANCZOS)
    sheet.paste(pv, (pad, pad))
    rep = scene.report
    sx, sy = pv.width, pv.height
    for key, colour in (("trim", (200, 30, 30)), ("safe", (30, 110, 200))):
        x0, y0, x1, y1 = rep["boxes"][key]
        d.rectangle((pad + x0 * sx, pad + y0 * sy, pad + x1 * sx, pad + y1 * sy), outline=colour, width=2)
    face = pf.PRESETS["modern"]["faces"]
    big, small = pf.font(face["bold"], 40), pf.font(face["text"], 25)
    x, y = int(W * 0.6), pad
    d.text((x, y), "Print proof", font=big, fill=(30, 30, 30))
    y += 70
    c = scene.canvas
    mt = rep.get("min_text") or {}
    lines = [title, "",
             f"Trim: {sz.cm(c.width_mm)} × {sz.cm(c.height_mm)} cm",
             f"Bleed: {c.bleed_mm:g} mm each side (red line = trim)",
             f"Safe area: blue line",
             f"Resolution: {c.dpi} dpi · {c.size_px[0]} × {c.size_px[1]} px",
             "Colour: sRGB (no CMYK conversion)",
             f"Smallest text: {mt.get('cap_mm')} mm capitals ({mt.get('role')})",
             f"Distance minimum: {mt.get('need_mm')} mm ({mt.get('distance')})",
             "Contrast: " + ("all text passes WCAG AA" if rep.get("all_pass") else "check the flagged lines")]
    for g in rep.get("gamut") or []:
        lines.append(f"Prints duller: {g['role']} {g['hex']} (print-safe {g['safe']})")
    if rep.get("shape") == "round":
        lines.append("Shape: round; cut on the trim circle")
    for ln in lines:
        d.text((x, y), ln, font=small, fill=(40, 40, 40))
        y += 40
    return sheet


# ---------------------------------------------------------------- SVG

WEIGHTS = {"thin": 100, "extralight": 200, "light": 300, "regular": 400, "medium": 500, "semibold": 600,
           "bold": 700, "extrabold": 800, "black": 900}


def _font_ref(face) -> tuple[str, int]:
    fam, style = pf.family_name(str(face.path))
    weight = face.weight or WEIGHTS.get(style.replace(" ", "").lower(), 400)
    return fam, weight


def _data(img: Image.Image, fmt: str, quality: int = 92) -> str:
    buf = io.BytesIO()
    if fmt == "JPEG":
        img.convert("RGB").save(buf, "JPEG", quality=quality, subsampling=0)
        mime = "image/jpeg"
    else:
        img.save(buf, "PNG", compress_level=6)
        mime = "image/png"
    return f"data:{mime};base64,{base64.b64encode(buf.getvalue()).decode()}"


def _clip(shape: str, x0, y0, x1, y1, radius: float) -> str:
    w, h = x1 - x0, y1 - y0
    if shape == "circle":
        return f'<ellipse cx="{_n(x0 + w / 2)}" cy="{_n(y0 + h / 2)}" rx="{_n(w / 2)}" ry="{_n(h / 2)}"/>'
    if shape == "arch":
        r = w / 2
        return (f'<path d="M{_n(x0)} {_n(y1)} L{_n(x0)} {_n(y0 + r)} A{_n(r)} {_n(r)} 0 0 1 {_n(x1)} {_n(y0 + r)} '
                f'L{_n(x1)} {_n(y1)} Z"/>')
    return f'<rect x="{_n(x0)}" y="{_n(y0)}" width="{_n(w)}" height="{_n(h)}" rx="{_n(radius)}"/>'


def svg(scene: Scene, assets: Assets) -> str:
    """Editable layers: shapes as shapes, real text in the bundled fonts (embedded, so it opens the same
    anywhere), the photo, illustration and logo as embedded pictures. Inkscape and Illustrator both read the
    groups as layers; a hidden Guides layer holds the trim and safe lines."""
    c = scene.canvas
    fw, fh = c.full_mm
    B = c.bleed_mm
    groups = {k: [] for k in raster.LAYERS}
    defs, faces, clip_n = [], {}, 0
    for e in scene.els:
        x0, y0, x1, y1 = e.box
        g = groups[e.layer]
        if e.kind == "rect":
            g.append(f'<rect x="{_n(x0)}" y="{_n(y0)}" width="{_n(x1 - x0)}" height="{_n(y1 - y0)}" '
                     f'rx="{_n(e.radius)}" fill="{e.fill}"/>')
        elif e.kind == "circle":
            g.append(f'<ellipse cx="{_n((x0 + x1) / 2)}" cy="{_n((y0 + y1) / 2)}" rx="{_n((x1 - x0) / 2)}" '
                     f'ry="{_n((y1 - y0) / 2)}" fill="{e.fill}"/>')
        elif e.kind == "frame":
            i = e.stroke / 2
            if e.role == "ring":
                g.append(f'<ellipse cx="{_n((x0 + x1) / 2)}" cy="{_n((y0 + y1) / 2)}" rx="{_n((x1 - x0) / 2 - i)}" '
                         f'ry="{_n((y1 - y0) / 2 - i)}" fill="none" stroke="{e.fill}" stroke-width="{_n(e.stroke)}"/>')
            else:
                g.append(f'<rect x="{_n(x0 + i)}" y="{_n(y0 + i)}" width="{_n(x1 - x0 - 2 * i)}" '
                         f'height="{_n(y1 - y0 - 2 * i)}" rx="{_n(e.radius)}" fill="none" stroke="{e.fill}" '
                         f'stroke-width="{_n(e.stroke)}"/>')
        elif e.kind == "image":
            src = getattr(assets, e.src or "", None)
            if src is None:
                continue
            # never more pixels than the print needs, never more than the source has
            need = max(1, round((x1 - x0) * c.k)), max(1, round((y1 - y0) * c.k))
            if e.fit == "contain":
                bx = raster.contain_box(src.width, src.height, e.box)
                im = src.copy()
                im.thumbnail(need, Image.LANCZOS)
                g.append(f'<image x="{_n(bx[0])}" y="{_n(bx[1])}" width="{_n(bx[2] - bx[0])}" '
                         f'height="{_n(bx[3] - bx[1])}" xlink:href="{_data(im, "PNG")}"/>')
                continue
            region = raster.crop_box(src.width, src.height, x1 - x0, y1 - y0, *e.focus)
            crop = src.crop(tuple(round(v) for v in region))
            if crop.width > need[0]:
                crop = crop.resize(need, Image.LANCZOS)
            clip = ""
            if e.shape in ("rounded", "circle", "arch"):
                clip_n += 1
                defs.append(f'<clipPath id="clip{clip_n}">{_clip(e.shape, x0, y0, x1, y1, e.radius)}</clipPath>')
                clip = f' clip-path="url(#clip{clip_n})"'
            g.append(f'<image x="{_n(x0)}" y="{_n(y0)}" width="{_n(x1 - x0)}" height="{_n(y1 - y0)}" '
                     f'preserveAspectRatio="none"{clip} xlink:href="{_data(crop, "JPEG")}"/>')
        elif e.kind == "icon":
            im = icons.icon(e.icon, 256, lay.rgb(e.fill))
            g.append(f'<image x="{_n(x0)}" y="{_n(y0)}" width="{_n(x1 - x0)}" height="{_n(y1 - y0)}" '
                     f'href="{_data(im, "PNG")}"/>')
        elif e.kind == "text":
            fam, weight = _font_ref(e.face)
            faces[(fam, weight)] = e.face
            if e.align == "center":
                x, anchor = (x0 + x1) / 2, "middle"
            elif e.align == "right":
                x, anchor = x1, "end"
            else:
                x, anchor = x0, "start"
            if e.rtl and anchor != "middle":
                anchor = "start" if anchor == "end" else "end"
            spans = "".join(f'<tspan x="{_n(x)}" y="{_n(e.baseline + i * e.advance)}">{escape(ln)}</tspan>'
                            for i, ln in enumerate(e.lines))
            g.append(f'<text font-family="\'{escape(fam)}\'" font-weight="{weight}" font-size="{_n(e.em)}" '
                     f'fill="{e.fill}" text-anchor="{anchor}"' + (' direction="rtl"' if e.rtl else "")
                     + f' data-role="{e.role}">{spans}</text>')
    css = []
    for path in {str(f.path): f for f in faces.values()}:
        fam, style = pf.family_name(path)
        variable = "[" in Path(path).name
        weight = "100 900" if variable else str(WEIGHTS.get(style.replace(" ", "").lower(), 400))
        data = base64.b64encode(Path(path).read_bytes()).decode()
        css.append(f"@font-face{{font-family:'{fam}';src:url(data:font/ttf;base64,{data}) format('truetype');"
                   f"font-weight:{weight};}}")
    W, H = c.width_mm, c.height_mm
    m = (scene.report.get("boxes") or {}).get("safe")
    guides = [f'<rect x="0" y="0" width="{_n(W)}" height="{_n(H)}" fill="none" stroke="#D02020" stroke-width="0.3"/>']
    if m:
        sx0, sy0 = m[0] * fw - B, m[1] * fh - B
        sx1, sy1 = m[2] * fw - B, m[3] * fh - B
        guides.append(f'<rect x="{_n(sx0)}" y="{_n(sy0)}" width="{_n(sx1 - sx0)}" height="{_n(sy1 - sy0)}" '
                      'fill="none" stroke="#2060D0" stroke-width="0.3"/>')
    # TODO: a CutContour spot-colour path in the PDF for round stickers, once a print shop asks for one
    if scene.report.get("shape") == "round":
        guides.append(f'<ellipse cx="{_n(W / 2)}" cy="{_n(H / 2)}" rx="{_n(W / 2)}" ry="{_n(H / 2)}" fill="none" '
                      'stroke="#D02020" stroke-width="0.3"/>')
    labels = {"background": "Background", "photo": "Photo", "logo": "Logo", "text": "Text"}
    body = "".join(f'<g id="{k}" inkscape:groupmode="layer" inkscape:label="{labels[k]}">{"".join(v)}</g>'
                   for k, v in groups.items() if v)
    body += ('<g id="guides" inkscape:groupmode="layer" inkscape:label="Guides (trim, safe)" display="none">'
             + "".join(guides) + "</g>")
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="{_n(fw)}mm" height="{_n(fh)}mm" '
            f'viewBox="0 0 {_n(fw)} {_n(fh)}">\n<defs><style>{"".join(css)}</style>{"".join(defs)}</defs>\n'
            f'<g transform="translate({_n(B)} {_n(B)})">{body}</g>\n</svg>\n')


# ---------------------------------------------------------------- everything at once

def png_bytes(img: Image.Image, dpi: int, level: int = 4) -> bytes:
    buf = io.BytesIO()
    kw = {"compress_level": level, "dpi": (dpi, dpi)}
    icc = srgb_icc()
    if icc:
        kw["icc_profile"] = icc
    img.save(buf, "PNG", **kw)
    return buf.getvalue()


def make_all(scene: Scene, assets: Assets, folder: Path, stem: str, title: str, spec: dict,
             preview: Image.Image) -> dict:
    """Every file for one design, written into folder. Returns {format: (path, bytes)} and timings. The
    page is rendered once at print size; the layers once each after it, one at a time."""
    folder.mkdir(parents=True, exist_ok=True)
    c = scene.canvas
    out, timing = {}, {}
    t0 = time.perf_counter()
    page = raster.render(scene, assets, c.k)
    timing["render_s"] = round(time.perf_counter() - t0, 2)

    t = time.perf_counter()
    png = folder / f"{stem}.png"
    png.write_bytes(png_bytes(page, c.dpi))
    out["png"] = png
    timing["png_s"] = round(time.perf_counter() - t, 2)

    t = time.perf_counter()
    jp = jpeg(page, c.dpi)
    (folder / f"{stem}.jpg").write_bytes(jp)
    out["jpg"] = folder / f"{stem}.jpg"
    size = page.size
    del page
    proof = proof_sheet(scene, preview, title)
    (folder / f"{stem}.pdf").write_bytes(print_pdf(jp, size, c, proof, title))
    out["pdf"] = folder / f"{stem}.pdf"
    del jp
    timing["jpg_pdf_s"] = round(time.perf_counter() - t, 2)

    t = time.perf_counter()
    (folder / f"{stem}.svg").write_text(svg(scene, assets), encoding="utf-8")
    out["svg"] = folder / f"{stem}.svg"
    timing["svg_s"] = round(time.perf_counter() - t, 2)

    t = time.perf_counter()
    zp = folder / f"{stem}-layers.zip"
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        for i, layer in enumerate(raster.LAYERS, 1):
            if layer != "background" and not any(e.layer == layer for e in scene.els):
                continue
            im = raster.render(scene, assets, c.k, layers=(layer,))
            if layer != "background" and im.getbbox() is None:
                continue
            z.writestr(f"{i}-{layer}.png", png_bytes(im, c.dpi, 3))
            del im
        z.writestr("design.json", json.dumps({"size": spec.get("size"), "spec": spec, "report": scene.report},
                                             ensure_ascii=False, indent=2, default=str))
        z.writestr("README.txt", README.format(w=sz.cm(c.width_mm), h=sz.cm(c.height_mm), b=c.bleed_mm, dpi=c.dpi,
                                               px=f"{c.size_px[0]} x {c.size_px[1]}"))
    out["zip"] = zp
    timing["zip_s"] = round(time.perf_counter() - t, 2)
    timing["total_s"] = round(time.perf_counter() - t0, 2)
    return {"files": out, "timing": timing}


README = """Layers for {w} x {h} cm, {b:g} mm bleed on every side, {dpi} dpi ({px} px).

Every PNG is the full page including the bleed, so stacking them in order (1 at the bottom) rebuilds the design
in any editor. The background layer is opaque; the others are transparent. design.json has the text, fonts and
colours. Colours are sRGB.
"""
