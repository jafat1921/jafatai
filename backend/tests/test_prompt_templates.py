"""Prompt templates: the shipped JSON, previews, and the /prompt-templates aliases."""
import importlib.util
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import library as lib_api
from app.api.quick import QuickIn
from app.library import ASPECTS, STYLES
from app.main import app

DIR = Path(lib_api.TEMPLATE_DIR)
SLOT = re.compile(r"\[([^\[\]]{1,60})\]")
SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "gen_prompt_template_previews.py"


def _load(kind):
    return json.loads((DIR / f"{kind}.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("kind,minimum", [("image", 24), ("video", 16)])
def test_template_json_is_sound(kind, minimum):
    data = _load(kind)
    rows, cats = data["templates"], data["categories"]
    assert len(rows) >= minimum and len(set(cats)) == len(cats)
    assert {t["category"] for t in rows} == set(cats)  # every category used, none unknown
    for t in rows:
        assert t["id"].startswith(f"{kind}-") and re.fullmatch(r"[a-z0-9-]+", t["id"])
        assert t["title"] and t["description"] and t["tags"]
        d = t["defaults"]
        texts = [d.get("prompt_scaffold", ""), d.get("logline_hint", ""), t.get("preview_prompt", "")]
        slots = set(SLOT.findall(d["prompt_scaffold"]))
        assert 2 <= len(slots) <= 4, t["id"]
        for text in texts:
            missing = set(SLOT.findall(text)) - set(t["examples"])
            assert not missing, f"{t['id']}: no example for {missing}"
        if kind == "image":
            assert d["aspect"] in ASPECTS and d["style"] in STYLES and 1 <= d["count"] <= 4
        elif "authoring_mode" not in d:
            QuickIn(prompt=d["prompt_scaffold"], duration_s=d["duration_s"], aspect_ratio=d["aspect_ratio"],
                    style=d["style"], dialogue=d["dialogue"])
            assert 5 <= d["duration_s"] <= 120 and t.get("preview_prompt")


def test_ids_unique_and_text_templates_use_qwen():
    rows = _load("image")["templates"] + _load("video")["templates"]
    ids = [t["id"] for t in rows]
    assert len(ids) == len(set(ids))
    qwen = [t for t in rows if t["defaults"].get("model") == "qwen_image_2512"]
    assert 1 <= len(qwen) <= 6 and all('"[' in t["defaults"]["prompt_scaffold"] for t in qwen)
    urdu = [t for t in qwen if re.search(r"[؀-ۿ]", json.dumps(t["examples"], ensure_ascii=False))]
    assert len(urdu) >= 2


def test_preview_script_fills_every_template():
    spec = importlib.util.spec_from_file_location("gen_previews", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for t in mod.load_templates():
        r = mod.recipe(t)
        assert "[" not in r["prompt"] and r["params"]["width"] % 64 == 0
        assert r["model"] == ("qwen_image_2512" if t["defaults"].get("model") else "zimage_turbo")


def test_aliases_list_and_start(client):
    old = client.get("/api/templates", params={"type": "image"}).json()
    new = client.get("/api/prompt-templates", params={"type": "image"}).json()
    assert [t["id"] for t in old] == [t["id"] for t in new]
    cats = _load("image")["categories"]
    assert [cats.index(t["category"]) for t in new] == sorted(cats.index(t["category"]) for t in new)
    poster = next(t for t in new if t["id"] == "image-poster")
    assert poster["examples"]["TITLE"] and poster["tags"]

    r = client.post("/api/prompt-templates/image-poster/start").json()
    assert r["target"] == "image" and r["prefill"]["model"] == "qwen_image_2512"
    assert r["prefill"]["examples"]["TITLE"]
    assert client.post("/api/prompt-templates/nope/start").status_code == 404


def test_preview_endpoint(client, tmp_path, monkeypatch):
    monkeypatch.setattr(lib_api, "PREVIEW_DIR", tmp_path)
    (tmp_path / "image-portrait.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBPfake")
    rows = {t["id"]: t for t in client.get("/api/prompt-templates").json()}
    url = rows["image-portrait"]["preview_url"]
    assert url.startswith("/api/prompt-templates/image-portrait/preview?v=")
    assert rows["image-food"]["preview_url"] is None

    r = client.get(url)
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    assert "max-age" in r.headers["cache-control"] and r.content.endswith(b"fake")
    assert client.get("/api/templates/image-portrait/preview").status_code == 200
    assert client.get("/api/prompt-templates/image-food/preview").status_code == 404  # no file yet
    assert client.get("/api/prompt-templates/nope/preview").status_code == 404

    # an id can't walk out of the previews folder, even if one slipped into the catalogue
    outside = tmp_path.parent / "secret.webp"
    outside.write_bytes(b"x")
    monkeypatch.setattr(lib_api, "templates", lambda: {"../secret": {"id": "../secret"}})
    assert lib_api.preview_file("../secret") is None

    with TestClient(app) as anon:
        assert anon.get("/api/prompt-templates/image-portrait/preview").status_code == 401


def test_shipped_previews_are_small():
    files = list((DIR / "previews").glob("*.webp"))
    ids = {t["id"] for t in _load("image")["templates"] + _load("video")["templates"]}
    assert {f.stem for f in files} <= ids
    assert sum(f.stat().st_size for f in files) < 3.5 * 1024 * 1024
