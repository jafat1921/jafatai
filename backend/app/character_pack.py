"""Character packs (contract v25): one zip that carries a character to another workspace or server.

character.json holds the profile, the sheet's settings and each panel's metadata; the portrait, the panels
and the board ride along as PNGs. A board the user uploaded comes back as their sheet; a laid-out one is redrawn. A voice goes as its definition. A cloned voice's reference clip only goes
with its consent record, and comes back in only with it.
"""
import io
import json
import zipfile
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session

from app import character_panels as cp, character_sheet as cs, uploads, voice_gallery, voices
from app.config import get_settings
from app.models import Character, Generation, MediaItem, VoiceProfile, new_id, utcnow
from app.services import generation_file

FORMAT = "mixai.character"
VERSION = 1
PACK_MAX = 300 * uploads.MB
# what may be unpacked in all; a zip bomb stops here rather than filling the disk
UNPACKED_MAX = 600 * uploads.MB
SHEET_KEYS = ("preset", "counts", "lists", "extras", "keys", "backdrop", "titles", "labels", "footer", "ruler",
              "palette")


def _sniff_zip(head: bytes) -> str | None:
    return "application/zip" if head.startswith(b"PK\x03\x04") else None


ZIP = uploads.Profile(_sniff_zip, lambda _t: PACK_MAX,
                      lambda _t: HTTPException(413, "Character packs can be at most 300 MB"),
                      "a character pack (.zip) exported from Character Studio", PACK_MAX)


# ---------------------------------------------------------------- export

def _voice(db: Session, c: Character, z: zipfile.ZipFile) -> dict | None:
    if not c.voice_id:
        return None
    gid = voice_gallery.parse(c.voice_id)
    if gid is not None:
        return {"gallery": gid}
    v = voices.find_voice(db, c.workspace_id, c.voice_id)
    if v is None:
        return None
    out = {"id": v.id, "name": v.name, "kind": v.kind, "language": v.language, "notes": v.notes,
           "gender_hint": v.gender_hint, "design": v.design, "preset": v.preset, "ref_text": v.ref_text}
    if v.kind == "clone":
        g = db.get(Generation, v.ref_generation_id or "")
        path = generation_file(g) if g is not None else None
        if v.consent and path is not None and path.is_file():
            name = f"voice/reference{path.suffix.lower()}"
            z.write(path, name)
            out.update(reference=name, consent=v.consent)
        else:
            out["reference"] = None  # no consent record, no clip
    return out


def build(db: Session, c: Character) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        meta = {"format": FORMAT, "version": VERSION, "exported_at": utcnow().isoformat() + "Z",
                "name": c.name, "description": c.description, "profile": c.profile or {},
                "sheet": {k: (c.sheet or {}).get(k) for k in SHEET_KEYS if (c.sheet or {}).get(k) is not None},
                "layout": ((c.sheet or {}).get("board") or {}).get("layout"), "panels": [], "portrait": None,
                "board": None}
        p = cs.portrait(db, c.id)
        path = generation_file(p) if p is not None else None
        if path is not None and path.is_file():
            z.write(path, "portrait.png")
            meta["portrait"] = {"file": "portrait.png", "prompt": p.prompt, "approved": p.status == "approved",
                                "source": (p.params or {}).get("source")}
        for key, gens in cs.panel_gens(db, c.id).items():
            g = cs.current(gens)
            path = generation_file(g) if g is not None else None
            if path is None or not path.is_file():
                continue
            name = f"panels/{key}.png"
            z.write(path, name)
            meta["panels"].append({"key": key, "file": name, "prompt": g.prompt, "approved": g.status == "approved",
                                   "source": (g.params or {}).get("source")})
        board = (c.sheet or {}).get("board") or {}
        item = db.get(MediaItem, board.get("media_id") or "")
        bg = db.get(Generation, item.generation_id) if item is not None and item.generation_id else None
        path = generation_file(bg) if bg is not None and bg.status in cs.FINISHED else None
        if path is not None and path.is_file():
            z.write(path, "board.png")
            meta["board"] = "board.png"
            meta["board_uploaded"] = bool(board.get("uploaded"))
        meta["voice"] = _voice(db, c, z)
        z.writestr("character.json", json.dumps(meta, ensure_ascii=False, indent=2))
    return buf.getvalue()


# ---------------------------------------------------------------- import

def _read(z: zipfile.ZipFile, name: str | None) -> bytes | None:
    if not name or name not in z.namelist():
        return None
    return z.read(name)


def _pixels(data: bytes) -> Image.Image:
    # re-encoded, so nothing but pixels comes in from the pack
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.load()
            return im.convert("RGB")
    except (UnidentifiedImageError, OSError) as e:
        raise HTTPException(422, f"A picture in the pack can't be read ({e})") from None


def _image_gen(c: Character, kind: str, prompt: str, data: bytes, status: str, params: dict, version: int) -> Generation:
    return cs.store_picture(c, _pixels(data), kind, prompt=prompt, status=status,
                            params={**params, "imported": True}, version=version)


def _import_voice(db: Session, cur, z: zipfile.ZipFile, v: dict | None) -> str | None:
    if not isinstance(v, dict):
        return None
    if v.get("gallery"):
        gid = f"gallery:{v['gallery']}"
        return gid if voices.find_voice(db, cur.workspace_id, gid) else None
    same = voices.find_voice(db, cur.workspace_id, str(v.get("id") or ""))
    if same is not None:
        return same.id  # the same workspace (or a re-import): keep using it
    kind = v.get("kind")
    p = VoiceProfile(workspace_id=cur.workspace_id, name=str(v.get("name") or "Imported voice")[:120], kind=kind,
                     language=str(v.get("language") or "en")[:12], notes=str(v.get("notes") or "")[:2000],
                     gender_hint=v.get("gender_hint"), ref_text=str(v.get("ref_text") or "")[:4000], uses=0)
    try:
        if kind == "design":
            p.design = voices.clean_design(v.get("design"))
        elif kind == "preset":
            p.preset = voices.clean_preset(v.get("preset"))
        elif kind == "clone":
            consent = v.get("consent") or {}
            data = _read(z, v.get("reference"))
            if data is None or " ".join(str(consent.get("statement") or "").split()) != voices.CONSENT \
                    or not str(consent.get("name") or "").strip():
                return None  # a clip without its consent record isn't brought in
            p.consent = {**consent, "imported_by": cur.id, "imported_at": utcnow().isoformat() + "Z"}
            item = _store_clip(db, cur, data, Path(v["reference"]).name)
            p.ref_media_id, p.ref_generation_id, p.ref_duration_s = item.id, item.generation_id, item.duration_s
        else:
            return None
    except HTTPException:
        return None
    db.add(p)
    db.flush()
    return p.id


def _store_clip(db: Session, cur, data: bytes, filename: str) -> MediaItem:
    media_type = uploads.sniff_audio(data[:64])
    if media_type is None:
        raise HTTPException(422, "The voice clip in the pack isn't audio")
    return _store_upload(db, cur, data, media_type, filename, "Voice reference (imported)")


def _store_upload(db: Session, cur, data: bytes, media_type: str, filename: str, title: str) -> MediaItem:
    """Into the Library the way /media/upload stores a file. This commits."""
    import hashlib

    from app.catalogue import importer
    from app.library import media_dir

    folder, rel = media_dir(cur.workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / f".pack-{new_id()}.part"
    tmp.write_bytes(data)
    got = uploads.Received(tmp, media_type, len(data), filename, title, hashlib.sha256(data).hexdigest(), {})
    item, _ = importer.store(db, cur.workspace_id, cur.id, got, folder, rel)
    return item


def import_zip(db: Session, cur, path: Path) -> Character:
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise HTTPException(422, "That isn't a zip file") from None
    with z:
        if sum(i.file_size for i in z.infolist()) > UNPACKED_MAX:
            raise HTTPException(413, "This pack unpacks to more than 600 MB")
        raw = _read(z, "character.json")
        try:
            meta = json.loads(raw or b"")
        except ValueError:
            meta = None
        if not isinstance(meta, dict) or meta.get("format") != FORMAT:
            raise HTTPException(422, "This zip isn't a character pack (no character.json)")
        if int(meta.get("version") or 0) > VERSION:
            raise HTTPException(422, "This pack was made by a newer version of the studio")
        name = " ".join(str(meta.get("name") or "").split())[:200] or "Imported character"
        profile = {k: v for k, v in (meta.get("profile") or {}).items() if k in cs.PROFILE_FIELDS}
        sheet = {k: v for k, v in (meta.get("sheet") or {}).items() if k in SHEET_KEYS}
        if meta.get("layout") in cs.LAYOUTS:
            sheet["board"] = {"layout": meta["layout"]}
        c = Character(workspace_id=cur.workspace_id, project_id=None, name=name,
                      description=str(meta.get("description") or "")[:4000], source="user", locked=True,
                      profile=cs.clean_profile({}, profile), sheet={**sheet, "imported_at": utcnow().isoformat() + "Z"})
        db.add(c)
        db.flush()
        por = meta.get("portrait") or {}
        data = _read(z, por.get("file"))
        if data is not None:
            db.add(_image_gen(c, "portrait", por.get("prompt") or "", data, "approved" if por.get("approved") else "ready",
                              {"source": "upload"} if por.get("source") == "upload" else {}, 1))
        for p in meta.get("panels") or []:
            key = str(p.get("key") or "")
            data = _read(z, p.get("file"))
            if data is None or cp.panel(key, sheet.get("extras")) is None:
                continue
            db.add(_image_gen(c, "sheet_view", p.get("prompt") or "", data,
                              "approved" if p.get("approved") else "ready",
                              {"panel": key, "view": key, "source": p.get("source")}, 1))
        db.flush()
        own = _read(z, meta.get("board")) if meta.get("board_uploaded") else None
        if own is not None:
            # the user's own sheet: kept as it is (re-encoded), never redrawn from the panels
            buf = io.BytesIO()
            _pixels(own).save(buf, "PNG")
            item = _store_upload(db, cur, buf.getvalue(), "image/png", "sheet.png", f"{name} · own sheet"[:300])
            cs.use_own_sheet(db, c, item)
        elif any(cs.current(v) for v in cs.panel_gens(db, c.id).values()):
            # a laid-out board is redrawn here rather than trusted from the pack
            cs.queue_board(db, c, (sheet.get("board") or {}).get("layout"))
        # last on purpose: storing a file commits, so everything before it has to be complete by now
        c.voice_id = _import_voice(db, cur, z, meta.get("voice"))
    return c


async def receive_and_import(request: Request, db: Session, cur) -> Character:
    folder = get_settings().data_dir / "workspaces" / cur.workspace_id / "tmp"
    got = await uploads.receive(request, folder, ZIP)
    try:
        c = await run_in_threadpool(import_zip, db, cur, got.path)
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        got.path.unlink(missing_ok=True)
    return c
