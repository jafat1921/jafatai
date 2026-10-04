from fastapi import APIRouter

from app.api import ai, auth, characters, events, generations, jobs, locations, media, projects, reel, scenes, shots, system

router = APIRouter(prefix="/api")
for mod in (auth, system, projects, scenes, shots, characters, locations, generations, jobs, events, media, ai, reel):
    router.include_router(mod.router)
