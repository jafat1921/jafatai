from fastapi import APIRouter

from app.api import ai, auth, brands, catalog, characters, events, generations, jobs, library, locations, media, projects, quick, reel, scenes, shots, system, videos

router = APIRouter(prefix="/api")
for mod in (auth, system, projects, scenes, shots, characters, locations, generations, jobs, events, library, media, ai, reel, quick, catalog, videos, brands):
    router.include_router(mod.router)
