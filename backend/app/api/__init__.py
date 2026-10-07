from fastapi import APIRouter

from app.api import ai, auth, brands, catalog, characters, events, generations, jobs, library, locations, media, mentions, organise, projects, prompts, quick, reel, scenes, shots, system, videos

router = APIRouter(prefix="/api")
for mod in (auth, system, projects, scenes, shots, characters, locations, generations, jobs, events, library, organise, media, ai, reel, quick, catalog, videos, brands, prompts, mentions):
    router.include_router(mod.router)
