import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import inspect

from app import models  # noqa: F401  (registers tables on Base.metadata)
from app import mcp_server
from app.api import router as api_router
from app.config import REPO_ROOT, get_settings
from app.db import Base, SessionLocal, engine
from app.openapi import build_schema, docs_router
from app.origin import OriginCheck
from app.quota import QuotaExceeded
from app.seed import seed

log = logging.getLogger("mixai")
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"
# the shipped default and the .env.example placeholder: anyone can forge a session cookie with either
DEFAULT_SECRETS = {"change-me", "change-me-to-a-long-random-string", ""}


def warn_weak_secret(secret: str) -> bool:
    if secret in DEFAULT_SECRETS or len(secret) < 16:
        log.warning("APP_SECRET is the default or too short; session cookies can be forged. "
                    "Set a long random APP_SECRET in .env (python -c \"import secrets; print(secrets.token_urlsafe(48))\")")
        return True
    return False


@asynccontextmanager
async def lifespan(_app: FastAPI):
    s = get_settings()
    warn_weak_secret(s.app_secret)
    s.data_dir.mkdir(parents=True, exist_ok=True)
    # Alembic owns the schema. This only covers a fresh dev checkout where
    # nobody ran `alembic upgrade head` yet; it won't touch an existing DB.
    if not inspect(engine).has_table("user"):
        log.warning("empty database, creating tables directly (run alembic for real setups)")
        Base.metadata.create_all(engine)
    with SessionLocal() as db:
        seed(db)
    async with mcp_server.running():
        yield


def create_app() -> FastAPI:
    s = get_settings()
    # the docs live under /api (the proxy only passes /api through) and are gated, so FastAPI's own are off
    app = FastAPI(title="Jafat AI Studio", version="0.1.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.openapi = lambda: build_schema(app)
    # added before CORS so CORS wraps it: a refused write still carries the CORS headers
    app.add_middleware(OriginCheck, allowed=[s.public_base, *s.cors_origins])
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(QuotaExceeded)
    async def _over_quota(_request, exc: QuotaExceeded):
        # flat, so the app can read used_min / limit_min / resets_at without digging into detail
        return JSONResponse(exc.body, status_code=exc.status_code)

    app.include_router(docs_router)
    app.include_router(api_router)
    # MCP (Streamable HTTP) for Claude and other agents; an ASGI app of its own, so not in the OpenAPI spec
    app.add_route("/api/mcp", mcp_server.endpoint, methods=["GET", "POST", "DELETE"], include_in_schema=False)

    if FRONTEND_DIST.is_dir():
        index = FRONTEND_DIST / "index.html"
        dist_root = FRONTEND_DIST.resolve()

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str):
            if full_path == "api" or full_path.startswith("api/"):
                raise HTTPException(404, "Not found")
            candidate = (dist_root / full_path).resolve()
            if full_path and candidate.is_relative_to(dist_root) and candidate.is_file():
                # hashed build files never change under the same name; everything else is checked each time
                hashed = full_path.startswith("assets/")
                return FileResponse(candidate, headers={
                    "Cache-Control": "public, max-age=31536000, immutable" if hashed else "no-cache"})
            # client-side routes all land on index.html. Never served stale: an old copy points at build files
            # the next deploy removed ("error loading dynamically imported module")
            return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
