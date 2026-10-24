"""The public website's plan list: only what the Package designer shows on the website, nothing technical."""
from app.db import SessionLocal
from app.models import Package


def test_plans_show_only_website_packages_without_limits(anon):
    with SessionLocal() as db:
        db.add(Package(name="Clinic special", public=False, active=True, price_pkr=50_000, features={}))
        db.add(Package(name="Retired", public=True, active=False, price_pkr=100, features={}))
        db.add(Package(name="Creator", description="For regular creators.", public=True, active=True, price_pkr=2500,
                       period="month", gpu_min_day=500, features={"3d": False}, sort=5))
        db.commit()
    r = anon.get("/api/site/plans")  # no sign-in needed
    assert r.status_code == 200
    names = [p["name"] for p in r.json()]
    assert "Creator" in names and "Free" in names and "Pro" in names
    assert "Clinic special" not in names and "Retired" not in names and "Demo (7 days)" not in names
    creator = next(p for p in r.json() if p["name"] == "Creator")
    assert creator["price_pkr"] == 2500 and creator["description"] == "For regular creators."
    assert "3D Studio" not in creator["studios"] and "Image studio" in creator["studios"]
    text = r.text.lower()
    assert "gpu" not in text and "max_queued" not in text and "api and mcp" not in text


def test_sample_packages_fill_the_website(anon, capsys):
    from app import manage

    assert manage.main(["sample-packages"]) == 0
    assert manage.main(["sample-packages"]) == 0  # safe to run again
    names = [p["name"] for p in anon.get("/api/site/plans").json()]
    assert names == ["Free", "Creator", "Studio"]
    assert "on the website: Free, Creator, Studio" in capsys.readouterr().out
