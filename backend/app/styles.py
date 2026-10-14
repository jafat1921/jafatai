"""Image style catalogue (contract v31): templates/styles.json, read once.

A style is a prompt modifier: its positive text goes after the user's prompt (library.styled_prompt) and its
negative joins the user's own, but only for runs sampled with real CFG, since Z-Image Turbo, FLUX.2 klein and
Qwen's Lightning/Turbo speeds run at CFG 1 and never read a negative.
"""
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

FILE = Path(__file__).resolve().parent / "templates" / "styles.json"
PREVIEW_DIR = FILE.parent / "previews"


@dataclass(frozen=True)
class Style:
    id: str
    group: str
    label: str
    subtitle: str
    positive: str
    negative: str
    best_model: str
    preview: str


@lru_cache
def _data() -> dict:
    return json.loads(FILE.read_text(encoding="utf-8"))


@lru_cache
def catalogue() -> dict[str, Style]:
    """Every style by id, in file order. Aliases are not in here (see by_id)."""
    return {s["id"]: Style(**s) for s in _data()["styles"]}


def aliases() -> dict[str, str]:
    return dict(_data().get("aliases") or {})


@lru_cache
def by_id() -> dict[str, Style]:
    # painterly was a style before the catalogue; old requests and saved runs still say it
    out = dict(catalogue())
    out.update({old: out[new] for old, new in aliases().items()})
    return out


def groups() -> list[dict]:
    return list(_data()["groups"])


def get(style_id: str | None) -> Style | None:
    return by_id().get(style_id) if style_id else None


def restyle_strength(style: Style | None) -> float | None:
    if style is None:
        return None
    g = next((g for g in groups() if g["id"] == style.group), None)
    return g.get("restyle_strength") if g else None


def preview_file(style: Style) -> Path | None:
    root = PREVIEW_DIR.resolve()
    target = (root / style.preview).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        return None
    return target


def joined_negative(user: str | None, style: Style | None, cfg: float | None) -> str | None:
    """The user's negative plus the style's, when the sampler actually reads one."""
    parts = [(user or "").strip()]
    if style is not None and style.negative and (cfg or 1.0) > 1.0:
        parts.append(style.negative)
    text = ", ".join(p for p in parts if p)
    return text or None


def options() -> dict:
    """GET /images/options "styles" and "style_groups"."""
    rows = []
    for s in catalogue().values():
        f = preview_file(s)
        url = f"/api/images/styles/{s.id}/preview?v={int(f.stat().st_mtime)}" if f else None
        rows.append({"id": s.id, "group": s.group, "label": s.label, "subtitle": s.subtitle, "suffix": s.positive,
                     "negative": s.negative, "best_model": s.best_model, "preview_url": url})
    return {"styles": rows, "style_groups": groups(), "style_aliases": aliases()}
