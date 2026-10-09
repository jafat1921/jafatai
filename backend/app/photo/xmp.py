"""Lightroom presets (.xmp and .lrtemplate) -> develop params (port of NoorViz presets.js).

Regex rather than an XML parser on purpose: a preset is one rdf:Description with crs: attributes (or the
same names as child elements), and a regex can't be talked into fetching external entities.
Mapping fixes from the NoorViz version: Exposure2012 is in stops, so it goes through our 1.5-stop scale
instead of x20, and the parametric curve regions land on the right anchors.
"""
import math
import re
from pathlib import Path

from app.photo import develop as dv


class PresetError(ValueError):
    pass


# settings that don't change pixels (or that we deliberately ignore), never reported as "unmapped"
META = {
    "Name", "ShortName", "SortName", "Group", "Cluster", "UUID", "PresetType", "Version", "ProcessVersion",
    "SupportsAmount", "SupportsAmount2", "SupportsColor", "SupportsMonochrome", "SupportsHighDynamicRange",
    "SupportsNormalDynamicRange", "SupportsSceneReferred", "SupportsOutputReferred", "RequiresRGBTables",
    "CameraModelRestriction", "Copyright", "ContactInfo", "Description", "HasSettings", "AlreadyApplied",
    "WhiteBalance", "CameraProfile", "CameraProfileDigest", "Look", "LookTable", "ToneCurveName",
    "ToneCurveName2012", "ToneMapStrength", "OverrideLookVignette", "RawFileName", "title", "internalName",
    "type", "uuid", "version", "id", "settings", "value", "s", "AutoLateralCA", "LensProfileEnable",
    "LensProfileSetup", "Amount", "ConvertToGrayscale_set",
}
HSL = ("Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta")


def _value(s: str):
    s = s.strip()
    if s in ("True", "true"):
        return True
    if s in ("False", "false"):
        return False
    try:
        v = float(s)
        return v if math.isfinite(v) else s
    except ValueError:
        return s


def read_xmp(text: str) -> tuple[str | None, dict]:
    m: dict = {}
    for k, v in re.findall(r'crs:([A-Za-z0-9_]+)\s*=\s*"([^"]*)"', text):
        m.setdefault(k, _value(v))
    for k, v in re.findall(r"<crs:([A-Za-z0-9_]+)>([^<]*)</crs:\1>", text):
        m.setdefault(k, _value(v))
    name = None
    nm = re.search(r"<crs:Name>.*?<rdf:li[^>]*>([^<]+)</rdf:li>", text, re.S)
    if nm:
        name = nm[1].strip()
    elif isinstance(m.get("Name"), str):
        name = m["Name"].strip()
    return name, m


def read_lrtemplate(text: str) -> tuple[str | None, dict]:
    """Lua table. Settings are flat `Key = value` pairs inside `settings = { ... }`; the first match wins so
    nested tables further down (local corrections, retouch) can't overwrite top-level values."""
    body = text
    st = re.search(r"\bsettings\s*=\s*\{", text)
    if st:
        body = text[st.end():]
    m: dict = {}
    for k, v in re.findall(r'(\w+)\s*=\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|"[^"]*"|true|false)', body):
        if k in m:
            continue
        m[k] = v[1:-1] if v.startswith('"') else _value(v)
    name = None
    t = re.search(r'\btitle\s*=\s*(?:ZSTR\s*)?"([^"]*)"', text)
    if t:
        name = t[1].split("=", 1)[-1] if t[1].startswith("$$$/") else t[1]
    if not name:
        t = re.search(r'\binternalName\s*=\s*"([^"]*)"', text)
        name = t[1] if t else None
    name = (name or "").replace("~~", "").strip() or None
    return name, m


def _clamp(v, lo=-100.0, hi=100.0) -> float:
    return round(max(lo, min(hi, float(v))), 2)


def to_params(m: dict) -> tuple[dict, list[str], list[str]]:
    """Lightroom key map -> (params, mapped keys, unmapped keys with a non-default value)."""
    p: dict = {}
    used: set[str] = set()

    def num(key):
        v = m.get(key)
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None

    def take(key, dest, fn=lambda v: _clamp(v)):
        v = num(key)
        if v is None:
            return False
        p[dest] = fn(v)
        used.add(key)
        return True

    take("Exposure2012", "exposure", lambda v: _clamp(v / 1.5 * 100)) or \
        take("Exposure", "exposure", lambda v: _clamp(v / 1.5 * 100))
    take("Contrast2012", "contrast") or take("Contrast", "contrast", lambda v: _clamp(v - 25))
    for lr, ours in (("Highlights2012", "highlights"), ("Shadows2012", "shadows"), ("Whites2012", "whites"),
                     ("Blacks2012", "blacks"), ("Vibrance", "vibrance"), ("Saturation", "saturation")):
        take(lr, ours)
    take("Clarity2012", "clarity") or take("Clarity", "clarity")
    take("Sharpness", "sharpness", lambda v: _clamp(v, 0, 100))
    take("LuminanceSmoothing", "noiseReduction", lambda v: _clamp(v, 0, 100))
    take("PostCropVignetteAmount", "vignette")

    # white balance: incremental (JPEG presets) is already relative; an absolute Kelvin only counts when the
    # preset sets a custom white balance, otherwise it is just the camera's value saved along
    if not take("IncrementalTemperature", "temperature"):
        t = num("Temperature")
        if t is not None and t > 1000 and str(m.get("WhiteBalance", "Custom")) == "Custom":
            p["temperature"] = _clamp((t - 5500) / 30)
            used.add("Temperature")
    if not take("IncrementalTint", "tint"):
        if num("Tint") is not None and str(m.get("WhiteBalance", "Custom")) == "Custom":
            take("Tint", "tint")

    if m.get("ConvertToGrayscale") is True:
        p["saturation"] = -100.0
        used.add("ConvertToGrayscale")

    # parametric curve: LR splits 0..1 into shadows/darks/lights/highlights quarters; our anchors sit at
    # .25/.5/.75, and LR's slider moves the curve about a third as far as ours (approximate)
    curve = {}
    sh, dk, li, hi = (num(k) for k in ("ParametricShadows", "ParametricDarks", "ParametricLights",
                                        "ParametricHighlights"))
    if sh is not None:
        curve["shadows"] = _clamp(sh * 0.3)
    if dk is not None or li is not None:
        curve["mids"] = _clamp(((dk or 0) + (li or 0)) * 0.15)
    if hi is not None:
        curve["highlights"] = _clamp(hi * 0.3)
    for k in ("ParametricShadows", "ParametricDarks", "ParametricLights", "ParametricHighlights"):
        if num(k) is not None:
            used.add(k)
    if curve:
        p["curve"] = curve

    hsl = {}
    for band in HSL:
        vals = {}
        for ch, key in (("h", f"HueAdjustment{band}"), ("s", f"SaturationAdjustment{band}"),
                        ("l", f"LuminanceAdjustment{band}")):
            v = num(key)
            if v is not None:
                vals[ch] = _clamp(v)
                used.add(key)
        if vals:
            hsl[band.lower()] = vals
    if hsl:
        p["hsl"] = hsl

    unmapped = []
    for k, v in m.items():
        if k in used or k in META or k.startswith("Parametric") and k.endswith("Split"):
            continue
        if v in (0, 0.0, False, "", None) or (isinstance(v, str) and k not in ("ToneCurvePV2012",)):
            continue
        unmapped.append(k)
    return p, sorted(used), sorted(unmapped)


def parse(filename: str, data: bytes) -> dict:
    """-> {name, kind, params, mapped, unmapped}. Raises PresetError for anything unreadable."""
    ext = Path(filename).suffix.lower()
    text = data.decode("utf-8-sig", errors="replace")
    if ext == ".xmp":
        name, m = read_xmp(text)
    elif ext == ".lrtemplate":
        name, m = read_lrtemplate(text)
    else:
        raise PresetError("Not an .xmp or .lrtemplate file")
    if not m:
        raise PresetError("No Lightroom develop settings found in this file")
    params, mapped, unmapped = to_params(m)
    if not mapped:
        raise PresetError("None of this preset's settings can be applied here"
                          + (f" ({', '.join(unmapped[:6])})" if unmapped else ""))
    # point curves are nested (rdf:Seq / Lua table), invisible to the key regex; flag one that isn't straight
    if ext == ".xmp":
        for key, seq in re.findall(r"<crs:(ToneCurvePV2012\w*)>(.*?)</crs:\1>", text, re.S):
            pts = [s.replace(" ", "") for s in re.findall(r"<rdf:li>([^<]*)</rdf:li>", seq)]
            if any(pt not in ("0,0", "255,255") for pt in pts):
                unmapped.append(key)
    elif re.search(r"ToneCurvePV2012\w*\s*=\s*\{", text):
        unmapped.append("ToneCurvePV2012")
    return {"name": (name or Path(filename).stem)[:200], "kind": ext[1:], "params": dv.normalise(params),
            "mapped": mapped, "unmapped": sorted(set(unmapped))}
