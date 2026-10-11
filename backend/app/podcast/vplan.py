"""The AI video podcast's shot plan (contract v24): a multi-camera edit worked out from the episode mix's
timeline, the way a podcast editor would cut it. Pure functions, so the rules can be tested on their own."""
import math
import uuid

FPS = 24
MAX_CHUNK_S = 10.0  # one LTX take; MAX_FRAMES 257 is a little more
WIDE_OPEN_S = 2.0
WIDE_OPEN_MIN_LINE_S = 4.0
REACT_EVERY = 3
REACT_MIN_LINE_S = 4.5
REACT_S = (1.5, 3.0)
MEDIUM_EVERY = 3
MIN_SHOT_S = 0.5
EDGE_S = 0.25  # intro / outro shorter than this just goes to the neighbouring shot

TYPES = ("lipsync", "medium", "reaction", "wide", "cover")
LIPSYNC_TYPES = ("lipsync", "medium")
TALK_KINDS = ("speech", "recording", "ad")
HOST_ANGLES = ("close", "three_quarter", "listen")
SHARED_ANGLES = ("wide", "medium")


def snap(t: float) -> float:
    return round(round(float(t) * FPS) / FPS, 4)


def new_id() -> str:
    return str(uuid.uuid4())


def angle_key(host_id: str | None, angle: str) -> str:
    return f"{host_id}:{angle}" if host_id and angle in HOST_ANGLES else angle


def angle_host(key: str) -> str | None:
    host, _, angle = (key or "").rpartition(":")
    return host if host and angle in HOST_ANGLES else None


def default_angle(kind: str, host_id: str | None, alt: int = 0) -> str:
    if kind == "lipsync":
        return angle_key(host_id, "close" if alt % 2 == 0 else "three_quarter")
    if kind == "reaction":
        return angle_key(host_id, "listen")
    if kind in SHARED_ANGLES:
        return kind
    return ""


def _shot(kind: str, start: float, end: float, *, speaker=None, item=None, angle="") -> dict:
    return {"id": new_id(), "type": kind, "angle": angle, "speaker_id": speaker,
            "line_id": item["line_id"] if item else None, "line_start": float(item["start"]) if item else None,
            "chapter_id": item.get("chapter_id") if item else None, "text": (item or {}).get("text") or "",
            "start": start, "end": end, "marked": False}


def chunks(start: float, end: float, limit: float = MAX_CHUNK_S) -> list[tuple[float, float]]:
    n = max(1, math.ceil((end - start) / limit - 1e-9))
    step = (end - start) / n
    return [(start + i * step, start + (i + 1) * step if i + 1 < n else end) for i in range(n)]


def build(timeline: list[dict], total: float, host_ids: list[str], *, cover_intro: bool = False,
          cover_outro: bool = False) -> list[dict]:
    """Shots covering [0, total] with no gaps, in time order."""
    items = sorted(timeline or [], key=lambda t: t["start"])
    hosts = [h for h in host_ids if h]
    out: list[dict] = []
    first = float(items[0]["start"]) if items else total
    if first > EDGE_S:
        out += _fill("cover" if cover_intro else "wide", 0.0, first)

    alt: dict[str, int] = {}
    since_reaction = 0
    last_speaker: str | None = None
    chapter = object()
    for i, it in enumerate(items):
        s = float(it["start"])
        e = float(items[i + 1]["start"]) if i + 1 < len(items) else float(it["end"])
        if e - s <= 0:
            continue
        who = it.get("speaker_id")
        opens = it.get("chapter_id") != chapter
        chapter = it.get("chapter_id")
        if who not in hosts or it.get("kind") not in TALK_KINDS:
            out += _fill("wide", s, e, item=it)
            continue

        line: list[dict] = []
        if opens and e - s >= WIDE_OPEN_MIN_LINE_S and (i > 0 or not out):
            line.append(_shot("wide", s, s + WIDE_OPEN_S, speaker=who, item=it, angle="wide"))
            s += WIDE_OPEN_S
        since_reaction += 1
        reaction = None
        listeners = [h for h in hosts if h != who]
        if listeners and since_reaction >= REACT_EVERY and e - s >= REACT_MIN_LINE_S:
            r = min(REACT_S[1], max(REACT_S[0], (e - s) * 0.25))
            mid = s + (e - s - r) / 2
            listener = last_speaker if last_speaker in listeners else listeners[0]
            reaction = _shot("reaction", mid, mid + r, speaker=who, item=it, angle=angle_key(listener, "listen"))
            since_reaction = 0
        parts = [(s, reaction["start"]), (reaction["end"], e)] if reaction else [(s, e)]
        talk = [c for a, b in parts for c in chunks(a, b)]
        for n, (a, b) in enumerate(talk):
            if len(talk) >= MEDIUM_EVERY and n % MEDIUM_EVERY == MEDIUM_EVERY - 1:
                line.append(_shot("medium", a, b, speaker=who, item=it, angle="medium"))
            else:
                line.append(_shot("lipsync", a, b, speaker=who, item=it, angle=default_angle("lipsync", who, alt.get(who, 0))))
                alt[who] = alt.get(who, 0) + 1
            if reaction and abs(b - reaction["start"]) < 1e-6:
                line.append(reaction)
        out += line
        last_speaker = who

    end = float(items[-1]["end"]) if items else 0.0
    if total - end > EDGE_S:
        out += _fill("cover" if cover_outro else "wide", end, total)
    return tidy(out, total)


def _fill(kind: str, start: float, end: float, item=None) -> list[dict]:
    # a still cover can be any length; a generated wide is a take, so long music gets several
    spans = [(start, end)] if kind == "cover" else chunks(start, end)
    return [_shot(kind, a, b, item=item, angle=default_angle(kind, None)) for a, b in spans]


def tidy(shots: list[dict], total: float) -> list[dict]:
    """Snap to frames, close the gaps, fold slivers into their neighbour, run from 0 to total."""
    out: list[dict] = []
    for sh in shots:
        sh = {**sh, "start": snap(sh["start"]), "end": snap(sh["end"])}
        if out:
            sh["start"] = out[-1]["end"]
        if sh["end"] - sh["start"] < MIN_SHOT_S and out:
            out[-1]["end"] = max(out[-1]["end"], sh["end"])
            continue
        out.append(sh)
    if not out:
        return out
    out[0]["start"] = 0.0
    out[-1]["end"] = snap(total)
    if len(out) > 1 and out[0]["end"] - out[0]["start"] < MIN_SHOT_S:
        out[1]["start"] = 0.0
        out.pop(0)
    for sh in out:
        sh["duration"] = round(sh["end"] - sh["start"], 4)
    return out


def item_at(timeline: list[dict], t: float) -> dict | None:
    """The line being shown at t: the last one that started at or before it (its gap belongs to it)."""
    items = sorted(timeline or [], key=lambda x: x["start"])
    best = None
    for it in items:
        if float(it["start"]) <= t + 1e-6:
            best = it
        else:
            break
    if best is not None and best is items[-1] and t >= float(best["end"]):
        return None  # the outro
    return best


def refill(shot: dict, timeline: list[dict], host_ids: list[str]) -> dict:
    """After an edit: the speaker and line come from the mix. Looked up at the shot's middle, since frame
    snapping can put its start a hair before its line's."""
    it = item_at(timeline, (shot["start"] + shot["end"]) / 2)
    talk = it is not None and it.get("kind") in TALK_KINDS and it.get("speaker_id") in host_ids
    shot = {**shot, "line_id": it["line_id"] if talk else None, "line_start": float(it["start"]) if talk else None,
            "speaker_id": it.get("speaker_id") if talk else None,
            "chapter_id": it.get("chapter_id") if it else None, "text": (it.get("text") or "") if talk else "",
            "duration": round(shot["end"] - shot["start"], 4)}
    if shot["type"] in LIPSYNC_TYPES and not talk:
        shot["type"], shot["angle"] = "wide", "wide"
    return shot


def stats(plan: list[dict]) -> dict:
    out = {k: 0 for k in TYPES}
    for sh in plan:
        out[sh["type"]] = out.get(sh["type"], 0) + 1
    return {"shots": len(plan), **out, "seconds": round(sum(sh["end"] - sh["start"] for sh in plan), 3)}


def check(plan: list[dict], total: float) -> str | None:
    """Why an edited plan can't be used, or None."""
    if not plan:
        return "The plan has no shots"
    t = 0.0
    for n, sh in enumerate(plan, 1):
        if sh["type"] not in TYPES:
            return f"Shot {n} has an unknown type"
        if abs(sh["start"] - t) > 0.05:
            return f"Shot {n} doesn't start where shot {n - 1} ends" if n > 1 else "The first shot must start at 0"
        if sh["end"] - sh["start"] < MIN_SHOT_S - 1e-6:
            return f"Shot {n} is shorter than {MIN_SHOT_S:g} s"
        if sh["type"] != "cover" and sh["end"] - sh["start"] > MAX_CHUNK_S + 0.5:
            return f"Shot {n} is longer than {MAX_CHUNK_S:g} s; split it"
        t = sh["end"]
    if abs(t - total) > 0.1:
        return "The last shot must end where the episode ends"
    return None
