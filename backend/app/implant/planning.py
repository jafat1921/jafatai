"""The surgeon's rules of thumb: implant size from volume and profile, the expected cup change, and the
checks a planner would raise before anything is drawn. Approximate on purpose; the manufacturer's chart and the
surgeon have the last word."""
import math

# projection / base width for round implants, the usual industry steps
RATIO = {"low": 0.28, "moderate": 0.33, "moderate_plus": 0.38, "high": 0.43, "extra_high": 0.50}
# Tebbetts' High Five: the nipple-to-fold distance (at stretch) a volume wants
NIMF_TARGET = ((250, 7.0), (300, 8.0), (375, 8.5), (450, 9.0), (10_000, 9.5))


def dimensions(cc: float, profile: str) -> tuple[float, float]:
    """(base width, projection) in cm. The implant as a spherical cap, V = π/6 · h · (3a² + h²) with h = r·d and
    a = d/2, solved for d. 300 cc moderate-plus comes out at 11.9 cm against Mentor's 11.6."""
    r = RATIO.get(profile, RATIO["moderate"])
    d = (6 * cc / (math.pi * r * (0.75 + r * r))) ** (1 / 3)
    return round(d, 1), round(r * d, 1)


def cc_per_cup(base_width_cm: float | None) -> int:
    if not base_width_cm:
        return 200
    return 150 if base_width_cm <= 11 else 200 if base_width_cm <= 13 else 250


def cup_change(cc: float, base_width_cm: float | None) -> float:
    # to the nearest half cup; that's as precise as anyone talks about it
    return round(cc / cc_per_cup(base_width_cm) * 2) / 2


def cup_words(cups: float) -> str:
    if cups <= 0.5:
        return "about half a cup size"
    whole, half = int(cups), cups - int(cups) >= 0.5
    n = {1: "one", 2: "two", 3: "three"}.get(whole, str(whole))
    return f"about {n}{' and a half' if half else ''} cup size{'s' if cups > 1 else ''}"


CUPS = ("AA", "A", "B", "C", "D", "DD", "E", "F", "G")


def cup_of(bra_size: str | None) -> int | None:
    """The cup in "34B", "75 C", "b", "DD": its index in CUPS, None when there's no cup in it."""
    letters = "".join(ch for ch in (bra_size or "").upper() if ch.isalpha())
    return CUPS.index(letters) if letters in CUPS else None


def target_cup(bra_size: str | None, cups: float) -> str | None:
    """The cup she'd wear after, in words the edit model knows ("a full C cup"). Steps of 350 vs 425 cc were
    both "about two cup sizes" and came out alike; a target cup keeps them apart."""
    now = cup_of(bra_size)
    if now is None:
        return None
    t = min(len(CUPS) - 1 + 0.49, now + cups)
    letter = CUPS[int(t)]
    return f"a full {letter} cup" if t - int(t) >= 0.5 else f"a {letter} cup"


def _num(m: dict, key: str) -> float | None:
    v = m.get(key)
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def assess(opt: dict, m: dict) -> dict:
    """Dimensions, the expected cup change and the warnings for one option on this patient."""
    out: dict = {"sides": {}, "checks": []}
    warn = out["checks"].append
    for side in ("left", "right"):
        cc = float(opt[f"{side}_cc"])
        width, proj = dimensions(cc, opt["profile"])
        bw = _num(m, f"bw_{side}_cm")
        out["sides"][side] = {"width_cm": width, "projection_cm": proj, "cup_change": cup_change(cc, bw)}
        if bw:
            if width > bw + 0.5:
                warn({"level": "warn", "text": f"{side.title()}: the implant (≈{width} cm) is wider than her breast "
                                               f"base ({bw:g} cm). A higher profile or a smaller volume fits better."})
            elif width < bw - 2:
                warn({"level": "info", "text": f"{side.title()}: the implant (≈{width} cm) is much narrower than her "
                                               f"base ({bw:g} cm); the cleavage gap may look wide."})
        nimf = _num(m, f"nimf_{side}_cm")
        target = next(t for v, t in NIMF_TARGET if cc <= v)
        if nimf and nimf < target - 0.5:
            warn({"level": "info", "text": f"{side.title()}: nipple-to-fold {nimf:g} cm is short for {cc:g} cc "
                                           f"(about {target:g} cm); the fold may need lowering."})
    pinch = _num(m, "pinch_cm")
    if pinch is not None and pinch < 2 and opt["placement"] == "subglandular":
        warn({"level": "warn", "text": f"Upper-pole pinch {pinch:g} cm is thin for placement over the muscle: the "
                                       "edge may show or ripple. Dual plane is usually advised."})
    ptosis = _num(m, "ptosis_grade")
    if ptosis is not None and ptosis >= 2:
        warn({"level": "warn", "text": f"Ptosis grade {ptosis:g}: a lift is likely needed, and this simulation "
                                       "doesn't show one."})
    bl, br = _num(m, "bw_left_cm"), _num(m, "bw_right_cm")
    if bl and br and abs(bl - br) > 1 and opt["left_cc"] == opt["right_cc"]:
        warn({"level": "info", "text": f"Her base widths differ by {abs(bl - br):.1f} cm; different volumes per "
                                       "side may balance her better."})
    return out
