"""@-mentions (polish P2): search Cast, Locations and brand assets, and resolve prompt tokens.

A prompt carries a mention as `@[Mara](character:<uuid>)`. Before a job is queued the token becomes the
plain name, and the mentioned picture becomes a reference image when the flow can take references.
Flows that can't (text to video, image to image, Quick) get the name plus a short description instead.
"""
import re
from dataclasses import dataclass, field

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import brand
from app.library import FINISHED
from app.models import BrandKit, Character, Generation, Location, Project
from app.services import media_url

TYPES = ("character", "location", "product", "logo")
TOKEN = re.compile(r"@\[([^\]\n]{1,120})\]\((character|location|product|logo):([A-Za-z0-9_-]{1,64})\)")
LIMIT = 30
DESC_MAX = 200


@dataclass
class Entity:
    type: str
    id: str
    label: str
    description: str = ""
    hint: str = ""  # project title or kit name, so two "Mara"s can be told apart
    ref: Generation | None = None

    def out(self) -> dict:
        thumb = self.ref.file_path if self.ref is not None else None
        return {"type": self.type, "id": self.id, "label": self.label, "hint": self.hint or None,
                "thumb_url": media_url(thumb) if thumb else None,
                "ref_generation_id": self.ref.id if self.ref is not None else None}


@dataclass
class Resolved:
    prompt: str
    ref_ids: list[str] = field(default_factory=list)
    ref_labels: list[str] = field(default_factory=list)
    mentions: list[dict] = field(default_factory=list)


def _finished(g: Generation | None) -> Generation | None:
    return g if g is not None and g.status in FINISHED and g.file_path else None


def _picture(db: Session, target_type: str, target_id: str, kinds: tuple[str, ...]) -> Generation | None:
    """The approved picture, else the newest finished one."""
    rows = db.scalars(select(Generation).where(
        Generation.target_type == target_type, Generation.target_id == target_id, Generation.kind.in_(kinds),
        Generation.status.in_(FINISHED), Generation.file_path.is_not(None),
    ).order_by(Generation.created_at.desc())).all()
    for kind in kinds:
        hit = next((g for g in rows if g.kind == kind and g.status == "approved"), None)
        if hit:
            return hit
    return rows[0] if rows else None


def _character(db: Session, c: Character, hint: str = "") -> Entity:
    return Entity("character", c.id, c.name, c.description or "", hint,
                  _picture(db, "character", c.id, ("portrait", "sheet_view")))


def _location(db: Session, loc: Location, hint: str = "") -> Entity:
    return Entity("location", loc.id, loc.name, loc.description or "", hint,
                  _picture(db, "location", loc.id, ("establishing",)))


def _kit_assets(db: Session, kit: BrandKit) -> list[Entity]:
    out = []
    for variant, ref in (kit.logos or {}).items():
        if isinstance(ref, dict) and ref.get("media_id"):
            label = f"{kit.name} logo" if variant == "primary" else f"{kit.name} logo ({variant})"
            out.append(Entity("logo", ref["media_id"], label, ref.get("description") or "", kit.name,
                              _finished(brand.media_generation(db, kit.workspace_id, ref["media_id"]))))
    for p in kit.products or []:
        if p.get("media_id"):
            out.append(Entity("product", p["media_id"], p.get("name") or "Product", p.get("description") or "",
                              kit.name, _finished(brand.media_generation(db, kit.workspace_id, p["media_id"]))))
    return out


def _projects(db: Session, workspace_id: str, project_id: str | None) -> list[Project]:
    if project_id:
        p = db.get(Project, project_id)
        if p is None or p.workspace_id != workspace_id:
            raise HTTPException(404, "Project not found")
        return [p]
    return list(db.scalars(select(Project).where(Project.workspace_id == workspace_id)
                           .order_by(Project.updated_at.desc()).limit(20)))


def _matches(label: str, needle: str) -> bool:
    # word starts, so "ma" finds Mara and "brew" finds Leaf Cold Brew, but not Omar
    low = label.lower()
    return not needle or any(w.startswith(needle) for w in [low, *low.split()])


def search(db: Session, workspace_id: str, q: str = "", *, project_id: str | None = None,
           types: tuple[str, ...] = TYPES, kit_id: str | None = None) -> list[dict]:
    """Cast and locations (one project, or the recent ones), then the brand kit's logos and products."""
    needle = (q or "").strip().lower()
    found: list[Entity] = []
    if "character" in types or "location" in types:
        projects = {p.id: p for p in _projects(db, workspace_id, project_id)}
        hint = (lambda row: "") if project_id else (lambda row: projects[row.project_id].title)
        # filter on the name first; the picture lookup is a query per row
        for model, make, type_ in ((Character, _character, "character"), (Location, _location, "location")):
            if type_ not in types or not projects:
                continue
            rows = db.scalars(select(model).where(model.project_id.in_(list(projects))).order_by(model.name))
            found += [make(db, r, hint(r)) for r in [r for r in rows if _matches(r.name, needle)][:LIMIT]]
    if "logo" in types or "product" in types:
        kit = brand.get_kit(db, workspace_id, kit_id, project_id) if (kit_id or project_id) else None
        if kit is None and not kit_id:
            kit = brand.get_kit(db, workspace_id, "default")
        if kit is not None:
            found += [e for e in _kit_assets(db, kit) if e.type in types and _matches(e.label, needle)]
    # TODO: standalone Library images tagged "character" once the Library has tags people can set
    if needle:
        found.sort(key=lambda e: (not e.label.lower().startswith(needle), TYPES.index(e.type)))
    return [e.out() for e in found[:LIMIT]]


def parse(prompt: str) -> list[tuple[str, str, str]]:
    """(label, type, id) for each token, in order of appearance."""
    return [(m.group(1), m.group(2), m.group(3)) for m in TOKEN.finditer(prompt or "")]


def plain(prompt: str) -> str:
    return TOKEN.sub(lambda m: m.group(1), prompt or "")


def _lookup(db: Session, workspace_id: str, type_: str, id_: str, kits: list[BrandKit]) -> Entity | None:
    if type_ in ("character", "location"):
        row = db.get(Character if type_ == "character" else Location, id_)
        if row is None:
            return None
        p = db.get(Project, row.project_id)
        if p is None or p.workspace_id != workspace_id:
            return None
        return _character(db, row) if type_ == "character" else _location(db, row)
    for kit in kits:
        hit = next((e for e in _kit_assets(db, kit) if e.type == type_ and e.id == id_), None)
        if hit:
            return hit
    return None


def _short(text: str) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= DESC_MAX else text[:DESC_MAX].rsplit(" ", 1)[0] + "…"


def resolve(db: Session, workspace_id: str, prompt: str, *, budget: int, used: int = 0,
            model_label: str = "This model") -> Resolved:
    """Tokens -> plain names; mentioned pictures -> reference generation ids (in order, no repeats).

    budget is how many references the flow takes in all and `used` how many the request already fills
    (edit sources). With a budget of 0 the pictures are skipped and short descriptions go in the prompt.
    Too many pictures is a 422 rather than a silent drop, so nobody wonders why Mara looks different."""
    tokens = parse(prompt)
    if not tokens:
        return Resolved(prompt=prompt)
    kits = list(db.scalars(select(BrandKit).where(BrandKit.workspace_id == workspace_id))) \
        if any(t in ("logo", "product") for _, t, _ in tokens) else []
    seen: dict[tuple[str, str], Entity | None] = {}
    for label, type_, id_ in tokens:
        if (type_, id_) not in seen:
            seen[(type_, id_)] = _lookup(db, workspace_id, type_, id_, kits)

    res = Resolved(prompt=plain(prompt).strip())
    notes = []
    for (type_, id_), ent in seen.items():
        label = next(lbl for lbl, t, i in tokens if (t, i) == (type_, id_))
        row = {"type": type_, "id": id_, "label": label, "ref_generation_id": None}
        if ent is None:
            row["missing"] = True
        elif budget > 0 and ent.ref is not None:
            res.ref_ids.append(ent.ref.id)
            res.ref_labels.append(label)
            row["ref_generation_id"] = ent.ref.id
        elif ent.description:
            notes.append(f"{label}: {_short(ent.description).rstrip('.')}.")
        res.mentions.append(row)

    total = used + len(res.ref_ids)
    if res.ref_ids and total > budget:
        parts = f"{used} source{'s' if used != 1 else ''} + {len(res.ref_ids)} mentioned" if used else \
            f"{len(res.ref_ids)} mentioned"
        raise HTTPException(422, f"{model_label} takes at most {budget} reference pictures; this would use "
                                 f"{total} ({parts}). Remove a mention.")
    if notes:
        res.prompt = f"{res.prompt.rstrip('.')}. " + " ".join(notes)
    return res


def ref_preamble(labels: list[str], start: int = 1) -> str:
    """Qwen edit names its inputs "Picture 1..3"; saying which is which keeps faces on the right people."""
    if not labels:
        return ""
    return "; ".join(f"Picture {i} shows {name}" for i, name in enumerate(labels, start)) + ". "
