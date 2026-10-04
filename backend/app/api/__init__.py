from fastapi import APIRouter

from app.api import ai, auth, characters, events, generations, jobs, media, projects, scenes, system

router = APIRouter(prefix="/api")
for mod in (auth, system, projects, scenes, characters, generations, jobs, events, media, ai):
    router.include_router(mod.router)
