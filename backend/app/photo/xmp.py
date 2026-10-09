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
    # params v2: exposure in EV, like Lightroom itself
    p: dict = {"version": 2}
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

    take("Exposure2012", "exposure", lambda v: _clamp(v, -5, 5)) or take("Exposure", "exposure", lambda v: _clamp(v, -5, 5))
    take("Contrast2012", "contrast") or take("Contrast", "contrast", lambda v: _clamp(v - 25))
    for lr, ours in (("Highlights2012", "highlights"), ("Shadows2012", "shadows"), ("Whites2012", "whites"),
                     ("Blacks2012", "blacks"), ("Vibrance", "vibrance"), ("Saturation", "saturation")):
        take(lr, ours)
    take("Clarity2012", "clarity") or take("Clarity", "clarity")
    take("Sharpness", "sharpness", lambda v: _clamp(v, 0, 100))
    take("LuminanceSmoothing", "noiseReduction", lambda v: _clamp(v, 0, 100))
    take("PostCropVignetteAmount", "vignette")
    take("PostCropVignetteMidpoint", "vignetteMidpoint", lambda v: _clamp(v, 0, 100))
    take("PostCropVignetteRoundness", "vignetteRoundness")
    take("PostCropVignetteFeather", "vignetteFeather", lambda v: _clamp(v, 0, 100))
    take("PostCropVignetteHighlightContrast", "vignetteHighlights", lambda v: _clamp(v, 0, 100))
    style = num("PostCropVignetteStyle")
    if style is not None:
        p["vignetteStyle"] = {1: "highlight", 2: "color", 3: "paint"}.get(int(style), "highlight")
        used.add("PostCropVignetteStyle")
    take("GrainAmount", "grainAmount", lambda v: _clamp(v, 0, 100))
    take("GrainSize", "grainSize", lambda v: _clamp(v, 0, 100))
    take("GrainFrequency", "grainRoughness", lambda v: _clamp(v, 0, 100))
    calib = {}
    for lr, ours in (("ShadowTint", "shadowsTint"), ("RedHue", "redHue"), ("RedSaturation", "redSat"),
                     ("GreenHue", "greenHue"), ("GreenSaturation", "greenSat"), ("BlueHue", "blueHue"),
                     ("BlueSaturation", "blueSat")):
        v = num(lr)
        if v is not None:
            calib[ours] = _clamp(v)
            used.add(lr)
    if calib:
        p["calibration"] = calib

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
        p["treatment"] = "bw"
        used.add("ConvertToGrayscale")
        bw = {}
        for band in HSL:
            v = num(f"GrayMixer{band}")
            if v is not None:
                bw[band.lower()] = _clamp(v)
                used.add(f"GrayMixer{band}")
        if bw:
            p["bw"] = bw

    # Color Grading (2020+), or the older Split Toning it replaced
    grading: dict = {}
    for zone, lr in (("shadows", "Shadow"), ("midtones", "Midtone"), ("highlights", "Highlight"), ("global", "Global")):
        h, sat, lum = num(f"ColorGrade{lr}Hue"), num(f"ColorGrade{lr}Sat"), num(f"ColorGrade{lr}Lum")
        if any(v is not None for v in (h, sat, lum)):
            grading[zone] = {"h": _clamp(h or 0, 0, 360), "s": _clamp(sat or 0, 0, 100), "l": _clamp(lum or 0)}
            used.update(k for k in (f"ColorGrade{lr}Hue", f"ColorGrade{lr}Sat", f"ColorGrade{lr}Lum") if num(k) is not None)
    if not grading:
        for zone, lr in (("shadows", "Shadow"), ("highlights", "Highlight")):
            h, sat = num(f"SplitToning{lr}Hue"), num(f"SplitToning{lr}Saturation")
            if sat:
                grading[zone] = {"h": _clamp(h or 0, 0, 360), "s": _clamp(sat, 0, 100), "l": 0}
                used.update((f"SplitToning{lr}Hue", f"SplitToning{lr}Saturation"))
    for lr, ours, lo in (("ColorGradeBlending", "blending", 0), ("SplitToningBalance", "balance", -100)):
        v = num(lr)
        if v is not None and grading:
            grading[ours] = _clamp(v, lo, 100)
            used.add(lr)
    if grading:
        p["grading"] = grading

    # parametric curve and its split points map one to one since params v2
    pcurve = {}
    for lr, ours in (("ParametricShadows", "shadows"), ("ParametricDarks", "darks"), ("ParametricLights", "lights"),
                     ("ParametricHighlights", "highlights")):
        v = num(lr)
        if v is not None:
            pcurve[ours] = _clamp(v)
            used.add(lr)
    for lr, ours in (("ParametricShadowSplit", "s1"), ("ParametricMidtoneSplit", "s2"), ("ParametricHighlightSplit", "s3")):
        v = num(lr)
        if v is not None:
            pcurve[ours] = _clamp(v, 5, 95)
            used.add(lr)
    if pcurve:
        p["pcurve"] = pcurve
    points = {}
    for lr, ours in (("ToneCurvePV2012", "rgb"), ("ToneCurvePV2012Red", "red"), ("ToneCurvePV2012Green", "green"),
                     ("ToneCurvePV2012Blue", "blue")):
        raw = m.get(lr)
        if isinstance(raw, (list, tuple)):
            pts = []
            for item in raw:
                try:
                    x, y = (float(t) for t in str(item).split(","))
                    pts.append([_clamp(x, 0, 255), _clamp(y, 0, 255)])
                except ValueError:
                    continue
            if pts:
                points[ours] = pts
                used.add(lr)
    if points:
        p["points"] = points

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
        if v in (0, 0.0, False, "", None) or isinstance(v, (str, list)):
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
    # point curves are nested (rdf:Seq / Lua table), invisible to the key regex: pick them up here
    if ext == ".xmp":
        for key, seq in re.findall(r"<crs:(ToneCurvePV2012\w*)>(.*?)</crs:\1>", text, re.S):
            pts = [s.replace(" ", "") for s in re.findall(r"<rdf:li>([^<]*)</rdf:li>", seq)]
            if any(pt not in ("0,0", "255,255") for pt in pts):
                m[key] = pts
    else:
        for key, body in re.findall(r"(ToneCurvePV2012\w*)\s*=\s*\{([^}]*)\}", text):
            nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", body)]
            pts = [f"{nums[i]:g},{nums[i + 1]:g}" for i in range(0, len(nums) - 1, 2)]
            if any(pt not in ("0,0", "255,255") for pt in pts):
                m[key] = pts
    params, mapped, unmapped = to_params(m)
    if not mapped:
        raise PresetError("None of this preset's settings can be applied here"
                          + (f" ({', '.join(unmapped[:6])})" if unmapped else ""))
    return {"name": (name or Path(filename).stem)[:200], "kind": ext[1:], "params": dv.normalise(params),
            "mapped": mapped, "unmapped": sorted(set(unmapped))}
