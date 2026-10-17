"""3D Studio part 4 (M20, contract v40 §9): product shots of a model, saved as Ad Studio's product photos."""
from app.db import SessionLocal
from app.models import Generation, MediaItem
from tests.test_3d import _photo
from tests.test_3d_turntable import _model
from tests.test_accounts import PW, make_user
from tests.test_api_tokens import _user, login  # noqa: F401  (fixtures)
from tests.test_library import png_bytes


def _send(client, model_id, files):
    return client.post(f"/api/3d/{model_id}/shots", files=[("file", f) for f in files])


def _shot(angle, size=(64, 64), name=None):
    return (name or f"{angle}.png", png_bytes(size), "image/png")


def test_shots_become_linked_ad_parts(client, fast_driver):
    model = _model(client, fast_driver)
    r = _send(client, model["id"], [_shot("front"), _shot("left"), _shot("top")])
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["ids"] == [i["id"] for i in out["items"]] and len(out["ids"]) == 3
    assert [i["title"] for i in out["items"]] == ["Teapot · 3D · front", "Teapot · 3D · three-quarter left",
                                                 "Teapot · 3D · from above"]
    for it in out["items"]:
        assert it["kind"] == "image" and it["home"] == "ad" and it["origin"] == "generated"
        assert it["media_type"] == "image/png"
    with SessionLocal() as db:
        g = db.get(Generation, db.get(MediaItem, out["ids"][0]).generation_id)
        assert g.params["model3d_of"] == model["id"] and g.params["angle"] == "front"
        assert g.params["created_by"]["flow"] == "make_3d:shots"

    # working parts: out of the general list, in Ad Studio's picker (include_home=ad) and by id
    general = {i["id"] for i in client.get("/api/media?kind=image").json()["items"]}
    assert not general & set(out["ids"])
    picker = {i["id"] for i in client.get("/api/media?kind=image&include_home=character,ad").json()["items"]}
    assert set(out["ids"]) <= picker
    assert client.get(f"/api/media/{out['ids'][1]}").status_code == 200

    # and the brief takes them as product photos like any other picture
    r = client.post("/api/ads", json={"subject": "Teapot", "product_media_ids": out["ids"]})
    assert r.status_code in (201, 202), r.text


def test_shots_check_count_names_type_and_size(client, fast_driver, monkeypatch):
    model = _model(client, fast_driver)
    six = ["front", "left", "right", "side", "top", "back"]
    assert _send(client, model["id"], [_shot(a) for a in six]).status_code == 201
    r = _send(client, model["id"], [_shot(a) for a in six] + [_shot("front", name="extra.png")])
    assert r.status_code == 422
    assert _send(client, model["id"], [_shot("front"), _shot("front")]).status_code == 422
    assert _send(client, model["id"], [_shot("front", name="hero.png")]).status_code == 422
    assert _send(client, model["id"], []).status_code in (415, 422)
    jpeg = ("front.png", b"\xff\xd8\xff\xe0" + b"\0" * 80, "image/png")
    assert _send(client, model["id"], [jpeg]).status_code == 415
    # a broken PNG in the middle keeps none of them
    broken = ("left.png", b"\x89PNG\r\n\x1a\n" + b"\0" * 80, "image/png")
    before = client.get("/api/media?home=ad").json()["items"]
    assert _send(client, model["id"], [_shot("front"), broken, _shot("top")]).status_code == 415
    assert len(client.get("/api/media?home=ad").json()["items"]) == len(before)

    from app.api import model3d as api3d

    monkeypatch.setattr(api3d, "SHOT_MAX", 1000)
    r = _send(client, model["id"], [_shot("front", (400, 400))])
    assert r.status_code == 413 and "15 MB" in r.json()["detail"]


def test_shots_need_a_finished_own_model_and_both_studios(client, fast_driver, login):  # noqa: F811
    model = _model(client, fast_driver)
    pic = _photo(client)
    assert _send(client, pic["id"], [_shot("front")]).status_code == 404
    queued = client.post("/api/3d/make", json={"source_id": pic["id"]}).json()["item"]
    assert _send(client, queued["id"], [_shot("front")]).status_code == 409

    uid = make_user("bea@example.com", "Bea")
    bea = login({"email": "bea@example.com", "password": PW})
    assert _send(bea, model["id"], [_shot("front")]).status_code == 404
    viewer = login(_user("vi@test.local", "viewer"))
    assert _send(viewer, model["id"], [_shot("front")]).status_code == 403

    # bea's own model, then a package without Ad Studio
    ws_model = _model(bea, fast_driver)
    pid = client.post("/api/admin/packages", json={"name": "No ads", "features": {"ads": False}}).json()["id"]
    client.post(f"/api/admin/users/{uid}/subscription", json={"package_id": pid})
    r = _send(bea, ws_model["id"], [_shot("front")])
    assert r.status_code == 403 and "Ad Studio" in r.json()["detail"]
    with SessionLocal() as db:
        assert db.query(MediaItem).filter(MediaItem.home == "ad").count() == 0
