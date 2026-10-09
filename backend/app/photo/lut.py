""".cube 3D LUTs: parse, write, apply (trilinear), and bake develop params into one.

Tables are numpy arrays shaped (N, N, N, 3) indexed [b, g, r], which is the .cube data order (red changes
fastest), so reading and writing is a plain reshape.
"""
import re

import numpy as np

MIN_SIZE, MAX_SIZE = 2, 65


class CubeError(ValueError):
    pass


def identity(n: int) -> np.ndarray:
    g = np.linspace(0.0, 1.0, n, dtype=np.float32)
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")
    return np.stack([r, gg, b], axis=-1)


def parse_cube(text: str) -> dict:
    size = None
    title = ""
    dmin = np.zeros(3, dtype=np.float32)
    dmax = np.ones(3, dtype=np.float32)
    rows: list[list[float]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        head = line.split(None, 1)[0].upper()
        if head == "TITLE":
            m = re.match(r'TITLE\s+"?(.*?)"?\s*$', line, re.I)
            title = (m[1] if m else "").strip()[:200]
        elif head == "LUT_3D_SIZE":
            try:
                size = int(line.split()[1])
            except (IndexError, ValueError):
                raise CubeError("LUT_3D_SIZE isn't a number") from None
        elif head == "LUT_1D_SIZE":
            raise CubeError("1D LUTs aren't supported; export a 3D .cube")
        elif head == "DOMAIN_MIN":
            dmin = _three(line)
        elif head == "DOMAIN_MAX":
            dmax = _three(line)
        elif head in ("LUT_3D_INPUT_RANGE", "LUT_1D_INPUT_RANGE"):
            lo, hi = (float(x) for x in line.split()[1:3])
            dmin, dmax = np.full(3, lo, np.float32), np.full(3, hi, np.float32)
        elif head[0].isdigit() or head[0] in "-+.":
            try:
                vals = [float(x) for x in line.split()[:3]]
            except ValueError:
                raise CubeError(f"Bad data line: {line[:40]}") from None
            if len(vals) != 3:
                raise CubeError(f"Bad data line: {line[:40]}")
            rows.append(vals)
        # other keywords (LUT_IN_VIDEO_RANGE, vendor tags) don't change the numbers
    if size is None:
        raise CubeError("Not a 3D .cube file (no LUT_3D_SIZE)")
    if not MIN_SIZE <= size <= MAX_SIZE:
        raise CubeError(f"LUT_3D_SIZE {size} is outside {MIN_SIZE}..{MAX_SIZE}")
    if len(rows) != size ** 3:
        raise CubeError(f"Expected {size ** 3} entries for size {size}, found {len(rows)}")
    if np.any(dmax <= dmin):
        raise CubeError("DOMAIN_MAX must be above DOMAIN_MIN")
    table = np.asarray(rows, dtype=np.float32).reshape(size, size, size, 3)
    if not np.all(np.isfinite(table)):
        raise CubeError("The LUT holds non-numbers")
    return {"size": size, "title": title, "table": table, "domain_min": dmin, "domain_max": dmax}


def _three(line: str) -> np.ndarray:
    try:
        return np.array([float(x) for x in line.split()[1:4]], dtype=np.float32)
    except ValueError:
        raise CubeError(f"Bad domain line: {line[:40]}") from None


def write_cube(table: np.ndarray, title: str = "", comments: list[str] | None = None) -> str:
    n = table.shape[0]
    head = [f"# {c}" for c in comments or []]
    if title:
        head.append('TITLE "' + title.replace('"', "'")[:120] + '"')
    head += [f"LUT_3D_SIZE {n}", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"]
    flat = np.clip(table.reshape(-1, 3), 0.0, 1.0)
    body = "\n".join(f"{r:.6f} {g:.6f} {b:.6f}" for r, g, b in flat.tolist())
    return "\n".join(head) + "\n" + body + "\n"


def standard_table(cube: dict) -> np.ndarray:
    """The table resampled to a 0..1 input domain, so everything downstream can ignore DOMAIN_MIN/MAX."""
    dmin, dmax = cube["domain_min"], cube["domain_max"]
    if np.allclose(dmin, 0) and np.allclose(dmax, 1):
        return cube["table"]
    n = cube["size"]
    return apply_lut(identity(n).reshape(-1, 3), cube["table"], (dmin, dmax)).reshape(n, n, n, 3)


def apply_lut(rgb: np.ndarray, table: np.ndarray, domain=(None, None)) -> np.ndarray:
    """Trilinear lookup. rgb: (..., 3) floats; returns float32 of the same shape."""
    n = table.shape[0]
    x = rgb.astype(np.float32, copy=False)
    dmin, dmax = domain
    if dmin is not None:
        x = (x - dmin) / (dmax - dmin)
    f = np.clip(x, 0.0, 1.0) * (n - 1)
    i0 = np.minimum(f.astype(np.int32), n - 2)
    t = f - i0
    flat = table.reshape(-1, 3)
    ri, gi, bi = i0[..., 0], i0[..., 1], i0[..., 2]
    tr, tg, tb = t[..., 0:1], t[..., 1:2], t[..., 2:3]
    base = (bi * n + gi) * n + ri
    sg, sb = n, n * n

    def at(off):
        return flat[base + off]

    c00 = at(0) * (1 - tr) + at(1) * tr
    c10 = at(sg) * (1 - tr) + at(sg + 1) * tr
    c01 = at(sb) * (1 - tr) + at(sb + 1) * tr
    c11 = at(sb + sg) * (1 - tr) + at(sb + sg + 1) * tr
    c0 = c00 * (1 - tg) + c10 * tg
    c1 = c01 * (1 - tg) + c11 * tg
    return (c0 * (1 - tb) + c1 * tb).astype(np.float32, copy=False)


def bake(params: dict | None, size: int = 33, lut=None) -> np.ndarray:
    """Run the develop point operations on an identity lattice (sRGB in, sRGB out).

    lut: (table, amount) of a look's own .cube, applied as part of the pipeline like a render would."""
    from app.photo import develop as dv

    if not MIN_SIZE <= size <= MAX_SIZE:
        raise CubeError(f"size must be {MIN_SIZE}..{MAX_SIZE}")
    p = dv.normalise(params)
    for k in dv.NOT_IN_LUT:
        p[k] = [] if k == "lightPoints" else 0
    p.update(crop=None, rotate=0, flipH=False, flipV=False)
    ident = identity(size)
    img = ident.reshape(size * size, size, 3)
    out = dv.develop(img, p, lut=lut)
    return out.reshape(size, size, size, 3)


def mix(table: np.ndarray, amount: float) -> np.ndarray:
    """Blend a LUT with identity (video intensity)."""
    if amount >= 0.999:
        return table
    return identity(table.shape[0]) + (table - identity(table.shape[0])) * np.float32(max(0.0, amount))
