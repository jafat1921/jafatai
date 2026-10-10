from fastapi import APIRouter

from app.api import ai, audio, audio_edit, auth, brands, catalog, characters, events, generations, jobs, library, locations, looks, media, mentions, organise, photo, photos, projects, prompts, quick, reel, scenes, shots, system, videos, voices

router = APIRouter(prefix="/api")
for mod in (auth, system, projects, scenes, shots, characters, locations, generations, jobs, events, library, organise, media, ai, reel, quick, catalog, videos, audio, audio_edit, brands, prompts, mentions, photo, looks, photos, voices):
    router.include_router(mod.router)
