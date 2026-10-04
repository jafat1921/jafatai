import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import inspect

from app import models  # noqa: F401  (registers tables on Base.metadata)
from app.api import router as api_router
from app.config import REPO_ROOT, get_settings
from app.db import Base, SessionLocal, engine
from app.seed import seed

log = logging.getLogger("mixai")
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    s = get_settings()
    s.data_dir.mkdir(parents=True, exist_ok=True)
    # Alembic owns the schema. This only covers a fresh dev checkout where
    # nobody ran `alembic upgrade head` yet; it won't touch an existing DB.
    if not inspect(engine).has_table("user"):
        log.warning("empty database, creating tables directly (run alembic for real setups)")
        Base.metadata.create_all(engine)
    with SessionLocal() as db:
        seed(db)
    yield


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="Mix AI Cinema Studio", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router)

    if FRONTEND_DIST.is_dir():
        index = FRONTEND_DIST / "index.html"
        dist_root = FRONTEND_DIST.resolve()

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str):
            if full_path == "api" or full_path.startswith("api/"):
                raise HTTPException(404, "Not found")
            candidate = (dist_root / full_path).resolve()
            if full_path and candidate.is_relative_to(dist_root) and candidate.is_file():
                return FileResponse(candidate)
            # client-side routes all land on index.html
            return FileResponse(index)

    return app


app = create_app()
