"""Brand kit contact and socials (contract v36 addendum): the schema and the old `social` line, handle
normalisation, platform icons with and without resvg, footers that fit every format, the channel guard, the
brand-card contact tokens, and the per-campaign / per-ad footer picks."""
import importlib.util
from types import SimpleNamespace

import pytest
from PIL import ImageStat

from app import brand_templates as bt
from app.ads import copy as cp
from app.ads import fonts as fz
from app.ads import footer as ft
from app.ads import icons
from app.ads import layout as lay
from app.brand_schemas import BrandKitIn, norm_handle
from tests.test_ads import go_on, kit, llm, make, photo  # noqa: F401  (llm is a fixture)
from tests.test_brand_templates import _gen, _kit

FULL = {"phone": "+46 72 846 73 94", "whatsapp": "072-846 73 94", "email": "hej@ixperts.se",
        "website": "https://www.ixperts.se", "booking_url": "https://boka.ixperts.se/online",
        "location": "Sveavägen 12, 113 50 Stockholm", "opening_hours": "Mån–fre 8–18"}
SOCIALS = [{"platform": p, "handle": "@ixperts.se", "url": None, "show_in_ads": True}
           for p in ("instagram", "facebook", "tiktok", "youtube")]
MIXED = [{"platform": "instagram", "handle": "@ixperts.se"}, {"platform": "facebook", "handle": "@ixpertsstockholm"},
         {"platform": "linkedin", "handle": "ixperts-ab"}, {"platform": "tiktok", "handle": "@ixperts_cleaning"},
         {"platform": "pinterest", "handle": "@ixpertshome"}]
HAS_RESVG = importlib.util.find_spec("resvg_py") is not None


# ---------------------------------------------------------------- schema

@pytest.mark.parametrize("platform,handle,url,want", [
    ("instagram", " @ixperts .se ", None, "@ixperts.se"),
    ("instagram", "ixperts.se", None, "@ixperts.se"),
    ("instagram", "https://www.instagram.com/ixperts.se/", None, "@ixperts.se"),
    ("tiktok", "", "https://www.tiktok.com/@ixperts_cleaning?lang=sv", "@ixperts_cleaning"),
    ("linkedin", "", "linkedin.com/company/ixperts-ab/", "ixperts-ab"),
    ("youtube", "https://youtube.com/@ixperts", None, "@ixperts"),
    ("snapchat", "https://snapchat.com/add/ixperts", None, "@ixperts"),
    ("x", "@ixperts", "https://x.com/ixperts", "@ixperts"),
    ("whatsapp", "+46 72 846 73 94", None, "+46728467394"),
    ("whatsapp", "", "https://wa.me/46728467394", "+46728467394"),
])
def test_handles_are_normalised(platform, handle, url, want):
    got, link = norm_handle(platform, handle, url)
    assert got == want and link.startswith("https://")


@pytest.mark.parametrize("platform,handle", [("instagram", "@not a/handle!"), ("whatsapp", "12"),
                                             ("instagram", "@" + "x" * 70)])
def test_bad_handles_are_refused(platform, handle):
    with pytest.raises(ValueError):
        norm_handle(platform, handle)


def test_kit_schema_lifts_the_old_social_line():
    k = BrandKitIn(name="iXperts", contact={**FULL, "social": "@ixperts.se"})
    assert "social" not in k.contact.model_dump()
    assert [s.model_dump() for s in k.socials] == [{"platform": "instagram", "handle": "@ixperts.se",
                                                    "url": "https://instagram.com/ixperts.se", "show_in_ads": True}]
    k = BrandKitIn(name="x", contact={"social": "https://facebook.com/ixperts"})
    assert k.socials[0].platform == "facebook" and k.socials[0].handle == "@ixperts"
    # an explicit list wins over the old line, and repeats collapse
    k = BrandKitIn(name="x", contact={"social": "@old"},
                   socials=[{"platform": "x", "handle": "@new"}, {"platform": "x", "handle": "new"}])
    assert [s.handle for s in k.socials] == ["@new"]


def test_kit_api_contact_and_socials(client):
    r = client.post("/api/brand-kits", json={"name": "iXperts", "contact": {**FULL, "social": "@ixperts.se"}})
    assert r.status_code == 201, r.text
    k = r.json()
    assert k["contact"] == FULL and k["socials"][0]["handle"] == "@ixperts.se"
    r = client.patch(f"/api/brand-kits/{k['id']}", json={"socials": [
        {"platform": "tiktok", "handle": "https://tiktok.com/@ixperts", "show_in_ads": False},
        {"platform": "instagram", "handle": "@ixperts.se"}]})
    assert r.status_code == 200
    assert [(s["platform"], s["handle"], s["show_in_ads"]) for s in r.json()["socials"]] == [
        ("tiktok", "@ixperts", False), ("instagram", "@ixperts.se", True)]
    many = [{"platform": "x", "handle": f"@a{i}"} for i in range(11)]
    assert client.patch(f"/api/brand-kits/{k['id']}", json={"socials": many}).status_code == 422
    assert client.patch(f"/api/brand-kits/{k['id']}", json={"socials": [{"platform": "myspace", "handle": "@a"}]}
                        ).status_code == 422
    assert client.patch(f"/api/brand-kits/{k['id']}", json={"socials": [{"platform": "x", "handle": " "}]}
                        ).status_code == 422


# ---------------------------------------------------------------- icons

@pytest.mark.skipif(not HAS_RESVG, reason="resvg isn't available here")
def test_platform_icons_come_from_the_svgs():
    icons.mask.cache_clear()
    for p in ("instagram", "facebook", "tiktok", "x", "youtube", "pinterest", "snapchat", "threads", "whatsapp"):
        m = icons.mask(p, 48)
        if m is None or m.getextrema()[1] == 0:
            pytest.skip("resvg is installed but can't run here")
        assert m.size == (48, 48) and 0.05 < ImageStat.Stat(m).mean[0] / 255 < 0.9, p


def test_icons_fall_back_to_drawn_ones(monkeypatch):
    icons.mask.cache_clear()
    monkeypatch.setattr(icons, "_rasterise", lambda path, px: None)
    try:
        for kind in (*icons.PLATFORMS, *icons.KINDS):
            im = icons.icon(kind, 40, (255, 255, 255))
            assert im.size == (40, 40) and im.mode == "RGBA" and im.getchannel("A").getextrema()[1] > 0, kind
    finally:
        icons.mask.cache_clear()


# ---------------------------------------------------------------- the footer

def _faces():
    return fz.faces(fz.DEFAULT_PRESET, "latin", [])[0]


def _avail(fmt):
    w, h = lay.FORMATS[fmt]
    return w - 2 * round(0.065 * min(w, h) * 0.7)


@pytest.mark.parametrize("fmt", list(lay.FORMATS))
@pytest.mark.parametrize("socials", [SOCIALS, MIXED])
def test_footer_fits_every_format_with_everything_in_it(fmt, socials):
    spec = {"format": fmt, "language": "sv", "contact": FULL, "socials": socials,
            "follow": {"show": True}, "style": "frosted",
            "texts": {"headline": "Tänd ljusen", "body": "Varje vecka", "cta": "Boka"}}
    w, h = lay.FORMATS[fmt]
    p = ft.plan(spec, fmt, w, min(w, h), _faces())
    assert p.rows and len(p.rows) <= ft.MAX_ROWS[fmt]
    for row in p.rows:
        size = round(p.size * p.scale.get(row[0].row, 1.0))
        assert ft.row_width(row, size, _faces(), "sv") <= _avail(fmt), (fmt, [i.key for i in row])
    shown = [i.key for r in p.rows for i in r]
    # the digital items are the last to go; the address the first
    assert "website" in shown
    if p.dropped:
        assert p.dropped[0] in ("location", "opening_hours")
    img, rep = lay.render(spec, lay.AdAssets(photo=photo()))
    assert img.size == (w, h) and rep["contrast"]["footer"] >= lay.AA_TEXT
    assert rep["footer"]["rows"] == len(p.rows)


def test_story_footer_leads_with_follow_and_handles():
    spec = {"format": "9:16", "language": "sv", "contact": {"website": FULL["website"], "phone": FULL["phone"]},
            "socials": SOCIALS, "follow": {"show": True}}
    p = ft.plan(spec, "9:16", 1080, 1080, _faces())
    assert [i.label for i in p.rows[0]] == ["Följ oss"]
    social = p.rows[1][0]
    # every platform shares one handle, so it's written once after the icons
    assert social.icons == ["instagram", "facebook", "tiktok", "youtube"] and social.label == "@ixperts.se"
    assert p.scale["social"] > 1
    _, rep = lay.render({**spec, "texts": {"headline": "Tänd ljusen", "cta": "Boka"}}, lay.AdAssets(photo=photo()))
    top, bottom = 1920 * 0.13, 1920 * (1 - 0.18)
    assert all(b[1] >= top and b[3] <= bottom for b in rep["boxes"].values())
    # a custom line and an Urdu default
    assert ft.items({**spec, "follow": {"show": True, "text": "Häng med!"}})[1].label == "Häng med!"
    assert ft.follow_text("ur") == "ہَمیں فالو کَریں"


def test_square_is_one_row_and_feed_wraps():
    spec = {"language": "sv", "contact": {k: FULL[k] for k in ("website", "phone", "whatsapp", "email")},
            "socials": SOCIALS}
    sq = ft.plan({**spec, "format": "1:1"}, "1:1", 1080, 1080, _faces())
    feed = ft.plan({**spec, "format": "4:5"}, "4:5", 1080, 1080, _faces())
    wide = ft.plan({**spec, "format": "16:9"}, "16:9", 1920, 1080, _faces())
    assert len(sq.rows) == 1 and len(wide.rows) == 1
    assert len(feed.rows) == 2 and not feed.dropped
    assert sq.dropped or len(sq.rows[0]) == 4


def test_phone_and_whatsapp_share_a_line():
    its = ft.items({"language": "sv", "contact": {"phone": FULL["phone"], "whatsapp": FULL["whatsapp"]}})
    assert len(its) == 1 and its[0].icons == ["phone", "whatsapp"]
    assert its[0].label == "Ring/WhatsApp +46 72 846 73 94"
    its = ft.items({"language": "en", "contact": {"phone": "+46 70 111 22 33", "whatsapp": "+46 72 846 73 94"}})
    assert [i.label for i in its] == ["Call +46 70 111 22 33", "WhatsApp +46 72 846 73 94"]


def test_one_huge_label_is_cut_not_overflowed():
    spec = {"format": "1.91:1", "contact": {"website": "https://" + "very-long-sub-domain." * 6 + "example.com"}}
    p = ft.plan(spec, "1.91:1", 1200, 628, _faces())
    it = p.rows[0][0]
    assert it.label.endswith("…") and ft.item_width(it, p.size, _faces(), None) <= _avail("1.91:1")


def test_footer_off_or_empty():
    assert ft.plan({"footer": False, "contact": FULL}, "4:5", 1080, 1080, _faces()).rows == []
    img, rep = lay.render({"format": "4:5", "footer": False, "contact": FULL}, lay.AdAssets(photo=photo()))
    assert "footer" not in rep


# ---------------------------------------------------------------- the channel guard

def test_guard_strips_invented_handles_numbers_and_links():
    ch = cp.channels_of({"website": FULL["website"], "phone": FULL["phone"]},
                        [{"platform": "instagram", "handle": "@ixperts.se", "url": "https://instagram.com/ixperts.se"}])
    c, rep = cp.guard({"kicker": "Följ @ixperts.se och @städproffs", "headline": "Rent hemma",
                       "body": "Läs mer på ixperts.se eller cleanfast.com. Mejla hej@fake.se!",
                       "cta": "Boka via WhatsApp", "offers": []}, [], "", ch)
    assert c["kicker"] == "Följ @ixperts.se"
    assert "ixperts.se" in c["body"] and "cleanfast" not in c["body"] and "fake.se" not in c["body"]
    assert c["cta"] == "Boka"
    assert {"@städproffs", "cleanfast.com", "hej@fake.se"} <= set(rep["channels_removed"])
    # the kit's own number may stay (written the local way); an invented one goes
    c, rep = cp.guard({"headline": "Ring oss", "body": "Ring 072-846 73 94 eller 08-123 45 67", "offers": []},
                      [], "", ch)
    assert "072-846 73 94" in c["body"] and "08-123" not in c["body"]
    # with the channel in the kit, the CTA keeps it
    ch.platforms.add("whatsapp")
    assert cp.guard({"headline": "H", "cta": "Boka via WhatsApp", "offers": []}, [], "", ch)[0]["cta"] == \
        "Boka via WhatsApp"
    # no kit at all: every handle, link and platform goes
    c, _ = cp.guard({"headline": "Följ oss på Instagram", "body": "@x www.x.se", "offers": []}, [])
    assert c["headline"] == "Följ oss" and "@x" not in c["body"] and "x.se" not in c["body"]


def test_copywriter_hears_only_the_kits_channels(client, llm):
    k = kit(client, socials=[{"platform": "instagram", "handle": "@ixperts.se"}],
            contact={"phone": FULL["phone"], "whatsapp": FULL["whatsapp"], "website": FULL["website"]})
    make(client, brand_kit_id=k["id"])
    asked = next(x for x in llm if x["schema"] == "AdConcepts")["user"]
    assert "The brand's channels (the only ones a CTA may name): Instagram, WhatsApp, phone, website" in asked
    assert "Never write a handle, phone number, web address or email" in asked


# ---------------------------------------------------------------- brand cards

def test_card_contact_tokens_are_short_and_exact():
    k = SimpleNamespace(contact=FULL, socials=SOCIALS[:1])
    t = bt.contact_tokens(k)
    assert t["contact"] == "https://www.ixperts.se".removeprefix("https://") + " · @ixperts.se"
    assert t["social_clause"] == ', and a rounded button reading "@ixperts.se"'
    empty = bt.contact_tokens(SimpleNamespace(contact={}, socials=[]))
    assert empty["contact_clause"] == empty["contact_under_clause"] == empty["social_clause"] == ""
    assert bt.fill('Headline "Hi"{contact_under_clause}.', empty) == 'Headline "Hi".'


def test_story_card_gets_the_kits_handle(client):
    _kit(client, contact={"website": "ixperts.se"}, socials=[{"platform": "instagram", "handle": "@ixperts.se"}])
    r = client.post("/api/images/brand", json={
        "template_id": "image-brand-social-story", "mode": "scene",
        "scene_prompt": 'A story: the headline "Rent hemma", then "{brand}"{social_clause}, blank circle for a logo.'})
    assert r.status_code == 202, r.text
    assert _gen(r.json()["items"][0]["generation_id"]).prompt == (
        'A story: the headline "Rent hemma", then "iXperts", and a rounded button reading "@ixperts.se", blank '
        'circle for a logo.')


# ---------------------------------------------------------------- picks per campaign and per ad

def test_footer_picks_per_campaign_and_per_ad(client, llm):
    socials = [{"platform": "instagram", "handle": "@ixperts.se"},
               {"platform": "tiktok", "handle": "@ixperts", "show_in_ads": False}]
    k = kit(client, contact=FULL, socials=socials)
    c = go_on(client, make(client, brand_kit_id=k["id"], formats=["4:5", "9:16", "yt"]))
    ad = next(a for a in c["ads"] if a["format"] == "4:5")
    # the defaults lean digital: no address, email or hours; only the socials flagged for ads
    assert set(ad["spec"]["contact"]) == {"website", "booking_url", "phone", "whatsapp"}
    assert [s["handle"] for s in ad["spec"]["socials"]] == ["@ixperts.se"]
    assert ad["spec"]["follow"]["show"] is False and ad["spec"]["footer"] is True
    story = next(a for a in c["ads"] if a["format"] == "9:16")
    assert story["spec"]["follow"]["show"] is True and story["report"]["footer"]["items"][0] == "follow"
    thumb = next(a for a in c["ads"] if a["format"] == "yt")
    assert thumb["spec"]["footer"] is False and (thumb["width"], thumb["height"]) == (1280, 720)

    r = client.patch(f"/api/ads/{c['id']}/ads/{ad['id']}", json={
        "footer_items": {"contact": ["location", "website"], "socials": ["tiktok:ixperts"]},
        "follow": {"show": True, "text": "Häng med"}})
    assert r.status_code == 200, r.text
    spec = r.json()["spec"]
    assert list(spec["contact"]) == ["website", "location"] and spec["socials"][0]["platform"] == "tiktok"
    assert spec["follow"] == {"show": True, "text": "Häng med"} and r.json()["version"] == 2
    assert client.patch(f"/api/ads/{c['id']}/ads/{ad['id']}", json={"footer_items": {"contact": ["fax"]}}
                        ).status_code == 422

    # a campaign-wide pick
    c2 = go_on(client, make(client, brand_kit_id=k["id"], formats=["1:1"],
                            footer_items={"contact": ["phone"], "socials": []}))
    spec = c2["ads"][0]["spec"]
    assert list(spec["contact"]) == ["phone"] and spec["socials"] == []
    assert c2["brand_kit"]["socials"][1]["show_in_ads"] is False


def test_new_formats_render_from_their_photo_groups(client, llm):
    c = go_on(client, make(client, formats=["1.91:1", "2:3"]))
    sizes = {a["format"]: (a["width"], a["height"]) for a in c["ads"]}
    assert sizes == {"1.91:1": (1200, 628), "2:3": (1000, 1500)}
    assert all(a["status"] == "ready" for a in c["ads"])

