"""The public website's data (no sign-in): the packages the Package designer marks "Show on the website".
Hidden and custom packages never appear; they're offered to chosen clients from Admin."""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import packages as pk
from app.db import get_db
from app.models import Package

router = APIRouter(prefix="/site", tags=["site"])

# studios a visitor would recognise; "api" stays off a marketing page, and "stories" is the studio behind
# another product, not something Jafat sells
SHOWN = {k: v for k, v in pk.FEATURES.items() if k not in ("api", "stories")}


@router.get("/plans")
def plans(db: Session = Depends(get_db)):
    rows = db.scalars(select(Package).where(Package.public.is_(True), Package.active.is_(True),
                                            Package.custom_for_user_id.is_(None), Package.kind != "custom")
                      .order_by(Package.sort, Package.created_at))
    # what the visitor sees is what the admin wrote, the price and the studios; never the usage limits
    return [{"id": p.id, "name": p.name, "description": p.description, "price_pkr": p.price_pkr,
             "period": p.period, "days": p.days, "private_items": p.private_items,
             "studios": [label for key, label in SHOWN.items() if (p.features or {}).get(key, True) is not False]}
            for p in rows]
