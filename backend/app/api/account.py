"""The signed-in user's own package and GPU meter (contract v39). Tokens may read it too."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import packages as pk
from app.db import get_db
from app.quota import usage
from app.security import CurrentUser, get_current_user

router = APIRouter(prefix="/account", tags=["account"])


@router.get("/usage")
def my_usage(db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    if pk.expire_due(db):
        db.commit()
    return usage(db, cur.user)
