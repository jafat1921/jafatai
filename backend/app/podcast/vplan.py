"""The AI video podcast's plan (contract v24, continuous cameras): the episode split into segments, one
camera track per host per segment that rolls the whole time, short wide takes at the openings, and the cut
list an editor would make by switching between them. Pure functions, so the rules can be tested on their own.

Every track runs on the episode's own timeline, so a cut from one to another is seamless in time and the
cut list can change without rendering anything."""
import hashlib
import itertools
import math
import uuid

FPS = 24
SEGMENT_MAX_S = 120.0
MIN_SHOT_S = 2.5
LISTEN_S = (2.5, 4.0)
LISTEN_EVERY = (3, 4)  # lines between listener cutaways, alternating, so it doesn't feel metronomic
LONG_TURN_S = 15.0
WIDE_OPEN_S = 3.0
WIDE_TAKE_S = 6.0  # a chapter opening renders a little more wide than it shows, so the cut can grow
WIDE_MAX_S = 10.0  # one LTX piece
EDGE_S = 0.25
SNAP_REACH_S = 1.5

TALK_KINDS = ("speech", "recording", "ad")
HOST_ANGLES = ("close", "three_quarter", "listen")
SHARED_ANGLES = ("wide", "medium")
TRACK_ANGLE = "close"
WIDE = "wide"
COVER = "cover"


def words_between(lines: list[dict], a: float, b: float) -> str:
    """The words of these timed lines ({text, start, end}) spoken between a and b. A line running over an
    edge gives the share of its words that falls inside, split by time (the TTS pace is even enough for a
    prompt)."""
    out = []
    for x in lines:
        s, e = float(x.get("start", 0.0)), float(x.get("end", 0.0))
        if e <= a + 1e-6 or s >= b - 1e-6 or e <= s:
            continue
        words = (x.get("text") or "").split()
        lo = round(len(words) * max(0.0, (a - s) / (e - s)))
        hi = round(len(words) * min(1.0, (b - s) / (e - s)))
        if hi > lo:
            out.append(" ".join(words[lo:hi]))
    return " ".join(out).strip()


def snap(t: float) -> float:
    return round(round(float(t) * FPS) / FPS, 4)


def new_id() -> str:
    return str(uuid.uuid4())


def stable_id(*parts) -> str:
    # Shot ids are global, so the salt (the AI video's id) keeps two episodes with the same timing apart
    return str(uuid.UUID(hashlib.md5("|".join(str(p) for p in parts).encode()).hexdigest()))


def angle_key(host_id: str | None, angle: str) -> str:
    return f"{host_id}:{angle}" if host_id and angle in HOST_ANGLES else angle


def angle_host(key: str) -> str | None:
    host, _, angle = (key or "").rpartition(":")
    return host if host and angle in HOST_ANGLES else None


# ---------------------------------------------------------------- the timeline

def _items(timeline: list[dict]) -> list[dict]:
    return sorted(timeline or [], key=lambda t: float(t["start"]))


def gap_points(items: list[dict]) -> list[tuple[float, bool]]:
    """(the middle of the gap between two lines, whether the speaker changes there)."""
    out = []
    for a, b in zip(items, items[1:]):
        e, s = float(a["end"]), float(b["start"])
        out.append((snap((e + s) / 2 if s > e else s), a.get("speaker_id") != b.get("speaker_id")))
    return out


def regions(items: list[dict]) -> list[tuple[float, float]]:
    """Each line's stretch of the episode: from the gap before it to the gap after it."""
    pts = [p for p, _ in gap_points(items)]
    out = []
    for i, it in enumerate(items):
        a = pts[i - 1] if i > 0 else snap(it["start"])
        b = pts[i] if i < len(pts) else snap(it["end"])
        out.append((a, max(a, b)))
    return out


def is_talk(it: dict, hosts: list[str]) -> bool:
    return it.get("kind") in TALK_KINDS and it.get("speaker_id") in hosts


# ---------------------------------------------------------------- segments

def _split(a: float, b: float, points: list[tuple[float, bool]], max_s: float) -> list[float]:
    cuts, cur = [a], a
    while b - cur > max_s + 1e-6:
        n = math.ceil((b - cur) / max_s - 1e-9)
        target = cur + (b - cur) / n
        lo, hi = cur + MIN_SHOT_S, min(cur + max_s, b - MIN_SHOT_S)
        cands = [(t, change) for t, change in points if lo <= t <= hi]
        if cands:
            # near an even split, but a gap where the speaker changes wins: the camera changes there anyway
            t = min(cands, key=lambda p: abs(p[0] - target) + (0.0 if p[1] else 0.15 * max_s))[0]
        else:
            t = snap(cur + max_s)  # one line longer than a segment; nothing better to split at
        cuts.append(t)
        cur = t
    return cuts + [b]


def segments(timeline: list[dict], chapters: list[dict] | None, total: float, max_s: float = SEGMENT_MAX_S,
             salt: str = "") -> list[dict]:
    """The episode in pieces no longer than max_s, covering 0 … total: the chapters, each split again at
    the gap between two lines when it's too long. Chapter edges move back to the gap before their line."""
    items = _items(timeline)
    total = snap(total)
    points = gap_points(items)
    spans: list[tuple[float, str | None, str]] = []
    for c in sorted(chapters or [], key=lambda c: float(c["start"])):
        start = float(c["start"])
        before = [t for t, _ in points if t <= start + 1e-6]
        edge = 0.0 if not spans else (before[-1] if before else snap(start))
        if spans and edge <= spans[-1][0] + 1e-6:
            continue
        spans.append((edge, c.get("id"), c.get("title") or ""))
    if not spans:
        spans = [(0.0, None, "")]
    out = []
    for n, (a, cid, title) in enumerate(spans):
        b = spans[n + 1][0] if n + 1 < len(spans) else total
        edges = _split(a, b, points, max_s)
        for x, y in zip(edges, edges[1:]):
            if y - x <= 1e-6:
                continue
            out.append({"id": stable_id(salt, "segment", x, y), "index": len(out), "chapter_id": cid,
                        "title": title, "start": x, "end": y, "duration": round(y - x, 4)})
    return out


def segment_at(segs: list[dict], t: float) -> dict | None:
    for s in segs:
        if s["start"] - 1e-6 <= t < s["end"] - 1e-6:
            return s
    return segs[-1] if segs else None


# ---------------------------------------------------------------- tracks

def host_tracks(segs: list[dict], timeline: list[dict], host_ids: list[str], salt: str = "") -> list[dict]:
    items = _items(timeline)
    out = []
    for s in segs:
        for h in host_ids:
            lines = [it["line_id"] for it in items if it.get("speaker_id") == h and it.get("kind") in TALK_KINDS
                     and float(it["start"]) < s["end"] and float(it["end"]) > s["start"]]
            out.append(_track("host", h, s, s["start"], s["end"], salt, lines))
    return out


def _track(kind: str, camera: str, seg: dict | None, start: float, end: float, salt: str, lines=()) -> dict:
    return {"id": stable_id(salt, kind, camera, start, end), "kind": kind, "camera": camera,
            "host_id": camera if kind == "host" else None, "segment_id": seg["id"] if seg else None,
            "angle_key": angle_key(camera, TRACK_ANGLE) if kind == "host" else WIDE,
            "start": start, "end": end, "duration": round(end - start, 4), "lines": list(lines)}


# ---------------------------------------------------------------- the cut list

def _cut(start: float, end: float, camera: str | None) -> dict:
    return {"id": new_id(), "camera": camera, "start": start, "end": end}


def paint(cuts: list[dict], a: float, b: float, camera: str | None) -> list[dict]:
    """Lay [a, b) over the cut list with this camera, trimming whatever was there."""
    if b - a <= 1e-6:
        return cuts
    out = []
    for c in cuts:
        if c["end"] <= a + 1e-6 or c["start"] >= b - 1e-6:
            out.append(c)
            continue
        if c["start"] < a - 1e-6:
            out.append({**c, "end": a})
        if c["end"] > b + 1e-6:
            out.append({**c, "id": new_id(), "start": b})
    out.append(_cut(a, b, camera))
    return sorted(out, key=lambda c: c["start"])


def snap_to(t: float, snaps: list[float], lo: float = -math.inf, hi: float = math.inf,
            reach: float = SNAP_REACH_S) -> float:
    """The voice gap nearest t within reach (and within [lo, hi]), else t on its frame."""
    best = min((s for s in snaps if lo - 1e-6 <= s <= hi + 1e-6 and abs(s - t) <= reach),
               key=lambda s: abs(s - t), default=None)
    return snap(best if best is not None else min(max(t, lo), hi))


def build(timeline: list[dict], chapters: list[dict] | None, total: float, host_ids: list[str], *,
          cover_intro: bool = False, cover_outro: bool = False, max_s: float = SEGMENT_MAX_S,
          pauses: list[float] | None = None, salt: str = "") -> dict:
    """{segments, tracks, cuts, snaps} for the whole episode."""
    items = _items(timeline)
    hosts = [h for h in host_ids if h]
    total = snap(total)
    segs = segments(items, chapters, total, max_s, salt)
    edges = {snap(items[0]["start"]), snap(items[-1]["end"])} if items else set()
    snaps = sorted({p for p, _ in gap_points(items)} | edges | {snap(p) for p in pauses or []})
    regs = regions(items)
    talk = [(it, r) for it, r in zip(items, regs) if is_talk(it, hosts)]

    cuts = [_cut(0.0, total, None)]
    for it, (a, b) in talk:
        cuts = paint(cuts, a, b, it["speaker_id"])
    if len(hosts) > 1:
        cuts = _listeners(cuts, talk, hosts, snaps)

    wides: list[tuple[float, float]] = []
    first = regs[0][0] if items else total
    last = regs[-1][1] if items else total
    intro = first > EDGE_S
    if intro:
        if first >= MIN_SHOT_S or cover_intro:
            end = min(first, WIDE_MAX_S)
            wides.append((0.0, end))
            cuts = paint(cuts, 0.0, first if cover_intro else end, COVER if cover_intro else WIDE)
        else:
            intro = False
    # every chapter opens on the room; the first one already has when there's an intro
    opened = set()
    for s in segs:
        if s["chapter_id"] in opened or (s["index"] == 0 and intro) or s["start"] >= last - MIN_SHOT_S:
            opened.add(s["chapter_id"])
            continue
        opened.add(s["chapter_id"])
        a = s["start"]
        b = snap_to(a + WIDE_OPEN_S, snaps, a + MIN_SHOT_S, min(a + WIDE_MAX_S, s["end"]))
        wides.append((a, snap(min(a + max(WIDE_TAKE_S, b - a), a + WIDE_MAX_S, total))))
        cuts = paint(cuts, a, b, WIDE)
    if total - last > EDGE_S and (total - last >= MIN_SHOT_S or cover_outro):
        a = max(last, snap(total - WIDE_MAX_S))
        wides.append((a, total))
        cuts = paint(cuts, last if cover_outro else a, total, COVER if cover_outro else WIDE)

    cuts = tidy(_fill(cuts, hosts), total, wides)
    tracks = host_tracks(segs, items, hosts, salt)
    tracks += [_track("wide", WIDE, segment_at(segs, a), a, b, salt) for a, b in _merge_spans(wides)]
    return {"segments": segs, "tracks": tracks, "cuts": annotate(cuts, items, segs, hosts), "snaps": snaps}


def _merge_spans(spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1] + 1e-6 and max(b, out[-1][1]) - out[-1][0] <= WIDE_MAX_S + 1e-6:
            out[-1] = (out[-1][0], max(b, out[-1][1]))
        elif b - a > 1e-6:
            out.append((a, b))
    return out


def _listeners(cuts: list[dict], talk: list[tuple[dict, tuple[float, float]]], hosts: list[str],
               snaps: list[float]) -> list[dict]:
    """Cutaways to the listener: about every 3–4 lines, and inside long turns."""
    def listener(i: int, who: str) -> str:
        before = next((t[0]["speaker_id"] for t in reversed(talk[:i]) if t[0]["speaker_id"] != who), None)
        after = next((t[0]["speaker_id"] for t in talk[i + 1:] if t[0]["speaker_id"] != who), None)
        return before or after or next(h for h in hosts if h != who)

    def place(cuts, a, b, camera, s, e):
        # both ends land on a pause in the voice when one is close; a cutaway that ends the line keeps its end
        a = snap_to(a, snaps, s + MIN_SHOT_S, e - LISTEN_S[0])
        if abs(b - e) > 1e-6:
            b = snap_to(b, snaps, a + LISTEN_S[0], min(a + LISTEN_S[1], e - MIN_SHOT_S))
        return paint(cuts, a, b, camera)

    done: list[tuple[float, float]] = []
    every = itertools.cycle(LISTEN_EVERY)
    due, count = next(every), 0
    for i, (it, (s, e)) in enumerate(talk):
        count += 1
        d = e - s
        if count < due or d < MIN_SHOT_S + LISTEN_S[0]:
            continue
        span = min(LISTEN_S[1], max(LISTEN_S[0], d - MIN_SHOT_S))
        # in the middle when there's room both sides, else on the end of the line (a J-cut to the next voice)
        a = s + (d - span) / 2 if d >= 2 * MIN_SHOT_S + span else e - span
        cuts = place(cuts, a, a + span, listener(i, it["speaker_id"]), s, e)
        done.append((a, a + span))
        due, count = next(every), 0

    # a long turn (one host's lines in a row) gets a look at the listener every LONG_TURN_S or so
    i = 0
    while i < len(talk):
        j = i
        while j + 1 < len(talk) and talk[j + 1][0]["speaker_id"] == talk[i][0]["speaker_id"]:
            j += 1
        s, e = talk[i][1][0], talk[j][1][1]
        n = int((e - s) // LONG_TURN_S)
        for k in range(1, n + 1):
            mid = s + k * (e - s) / (n + 1)
            a, b = mid - LISTEN_S[1] / 2, mid + LISTEN_S[1] / 2
            if a - s < MIN_SHOT_S or e - b < MIN_SHOT_S or any(x < b + MIN_SHOT_S and y > a - MIN_SHOT_S
                                                                for x, y in done):
                continue
            cuts = place(cuts, a, b, listener(i, talk[i][0]["speaker_id"]), s, e)
            done.append((a, b))
        i = j + 1
    return cuts


def _fill(cuts: list[dict], hosts: list[str]) -> list[dict]:
    """Music and other speakers keep whatever camera was on (or the next one, at the very start)."""
    out = [dict(c) for c in cuts]
    known = [c["camera"] for c in out if c["camera"]]
    prev = known[0] if known else (hosts[0] if hosts else COVER)
    for c in out:
        if c["camera"] is None:
            c["camera"] = prev
        prev = c["camera"]
    return out


def merge_same(cuts: list[dict]) -> list[dict]:
    out: list[dict] = []
    for c in cuts:
        if out and out[-1]["camera"] == c["camera"]:
            out[-1]["end"] = c["end"]
        else:
            out.append(dict(c))
    return out


def _fits(c: dict, start: float, end: float, wides: list[tuple[float, float]]) -> bool:
    if c["camera"] != WIDE:
        return True
    return any(a - 0.05 <= start and end <= b + 0.05 for a, b in wides)


def tidy(cuts: list[dict], total: float, wides: list[tuple[float, float]] | None = None) -> list[dict]:
    """Snap to frames, close the gaps, join neighbours on the same camera, and fold cuts under MIN_SHOT_S
    into a neighbour (the one before, unless the wide take wouldn't stretch that far)."""
    wides = wides or []
    out: list[dict] = []
    for c in sorted(cuts, key=lambda c: c["start"]):
        c = {**c, "start": snap(c["start"]), "end": snap(c["end"])}
        if out:
            c["start"] = out[-1]["end"]
        if c["end"] > c["start"]:
            out.append(c)
    if not out:
        return out
    out[0]["start"], out[-1]["end"] = 0.0, snap(total)
    out = merge_same(out)
    changed = True
    while changed and len(out) > 1:
        changed = False
        for i, c in enumerate(out):
            if c["end"] - c["start"] >= MIN_SHOT_S - 1e-6:
                continue
            prev = out[i - 1] if i > 0 else None
            nxt = out[i + 1] if i + 1 < len(out) else None
            if prev is not None and _fits(prev, prev["start"], c["end"], wides):
                prev["end"] = c["end"]
            elif nxt is not None and _fits(nxt, c["start"], nxt["end"], wides):
                nxt["start"] = c["start"]
            elif prev is not None:
                prev["end"] = c["end"]
            else:
                nxt["start"] = c["start"]
            out.pop(i)
            out = merge_same(out)
            changed = True
            break
    for c in out:
        c["duration"] = round(c["end"] - c["start"], 4)
    return out


def item_at(timeline: list[dict], t: float) -> dict | None:
    """The line being heard at t: the last one that started at or before it (its gap belongs to it)."""
    best = None
    for it in _items(timeline):
        if float(it["start"]) <= t + 1e-6:
            best = it
        else:
            break
    if best is not None and t >= float(best["end"]) + 1.0:
        return None
    return best


def annotate(cuts: list[dict], timeline: list[dict], segs: list[dict], host_ids: list[str]) -> list[dict]:
    out = []
    for c in cuts:
        mid = (c["start"] + c["end"]) / 2
        it = item_at(timeline, mid)
        talk = it is not None and is_talk(it, host_ids)
        seg = segment_at(segs, c["start"])
        out.append({"id": c.get("id") or new_id(), "camera": c["camera"], "start": c["start"], "end": c["end"],
                    "duration": round(c["end"] - c["start"], 4),
                    "speaker_id": it.get("speaker_id") if talk else None,
                    "text": (it.get("text") or "") if talk else "", "segment_id": seg["id"] if seg else None})
    return out


def wide_spans(plan: dict) -> list[tuple[float, float]]:
    return [(t["start"], t["end"]) for t in plan.get("tracks") or [] if t["kind"] == "wide"]


def check(cuts: list[dict], total: float, cameras: set[str], wides: list[tuple[float, float]]) -> str | None:
    """Why an edited cut list can't be used, or None."""
    if not cuts:
        return "The cut list is empty"
    t = 0.0
    for n, c in enumerate(cuts, 1):
        if c["camera"] not in cameras:
            return f"Cut {n} uses a camera this episode doesn't have"
        if abs(c["start"] - t) > 0.05:
            return f"Cut {n} doesn't start where cut {n - 1} ends" if n > 1 else "The first cut must start at 0"
        if len(cuts) > 1 and c["end"] - c["start"] < MIN_SHOT_S - 1e-3:
            return f"Cut {n} is shorter than {MIN_SHOT_S:g} s"
        if not _fits(c, c["start"], c["end"], wides):
            return f"Cut {n}: the wide camera only rolls at the intro, the chapter openings and the outro"
        t = c["end"]
    if abs(t - total) > 0.1:
        return "The last cut must end where the episode ends"
    return None


def switch(cuts: list[dict], at: float, camera: str, snaps: list[float]) -> list[dict]:
    """Show `camera` from `at` (moved to the nearest voice gap) up to the next switch."""
    at = snap_to(at, snaps)
    out = [dict(c) for c in cuts]
    for i, c in enumerate(out):
        if c["start"] - 1e-6 <= at < c["end"] - 1e-6:
            if abs(at - c["start"]) < 1e-6:
                c["camera"] = camera
            else:
                out[i:i + 1] = [{**c, "end": at}, {**c, "id": new_id(), "start": at, "camera": camera}]
            break
    out = merge_same(out)
    for c in out:
        c["duration"] = round(c["end"] - c["start"], 4)
    return out


def apply_cover(plan: dict, cover_intro: bool, cover_outro: bool) -> list[dict]:
    """The cuts before the first line / after the last one switch between the wide take and the cover in
    place. The wide take only reaches so far, so the rest of a long intro goes to the next camera."""
    cuts = [dict(c) for c in plan.get("cuts") or []]
    if not cuts:
        return cuts
    wides = wide_spans(plan)
    for end, on in ((0, cover_intro), (-1, cover_outro)):
        c = cuts[end]
        if c.get("speaker_id") or c["camera"] not in (WIDE, COVER):
            continue
        if on:
            c["camera"] = COVER
            continue
        span = next(((a, b) for a, b in wides if a - 0.05 <= c["start"] < b or a < c["end"] <= b + 0.05), None)
        if span is None:
            continue
        c["camera"] = WIDE
        if end == 0 and c["end"] > span[1] + 0.05 and len(cuts) > 1:
            cuts[0]["end"], cuts[1]["start"] = span[1], span[1]
        elif end == -1 and c["start"] < span[0] - 0.05 and len(cuts) > 1:
            cuts[-1]["start"], cuts[-2]["end"] = span[0], span[0]
    for c in cuts:
        c["duration"] = round(c["end"] - c["start"], 4)
    return cuts


def stats(plan: dict) -> dict:
    tracks = plan.get("tracks") or []
    return {"segments": len(plan.get("segments") or []), "tracks": len(tracks),
            "host_tracks": sum(1 for t in tracks if t["kind"] == "host"),
            "wide_tracks": sum(1 for t in tracks if t["kind"] == "wide"),
            "cuts": len(plan.get("cuts") or []), "pieces": sum(int(t.get("pieces") or 0) for t in tracks),
            "seconds": round(sum(t["duration"] for t in tracks), 3)}
