import asyncio
from datetime import timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_db
from app.models import Generation, WorkerHeartbeat, utcnow
from app.schemas import _iso
from app.security import CurrentUser, get_current_user

router = APIRouter(tags=["system"])

PROBE_TIMEOUT = 4.0
WORKER_ALIVE_WINDOW = timedelta(seconds=30)


@router.get("/health")
def health():
    return {"status": "ok"}


def _comfy_headers(s: Settings) -> dict:
    return {"Authorization": f"Bearer {s.comfy_auth_token}"} if s.comfy_auth_token else {}


async def _probe_comfy(client: httpx.AsyncClient, url: str, s: Settings) -> dict:
    try:
        r = await client.get(f"{url}/system_stats", headers=_comfy_headers(s))
        r.raise_for_status()
        data = r.json()
    except Exception as e:  # any failure just means "not reachable" for the status pill
        return {"ok": False, "url": url, "error": str(e) or type(e).__name__}
    system = data.get("system", {})
    devices = [
        {"name": d.get("name", ""), "vram_total": d.get("vram_total"), "vram_free": d.get("vram_free")}
        for d in data.get("devices", [])
    ]
    return {"ok": True, "url": url, "version": system.get("comfyui_version"), "devices": devices}


async def _probe_llm(client: httpx.AsyncClient, s: Settings) -> dict:
    base = s.llm_base_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    try:
        r = await client.get(f"{base}/api/tags")
        r.raise_for_status()
        models = [m.get("name") for m in r.json().get("models", [])]
    except Exception as e:
        return {"ok": False, "url": base, "error": str(e) or type(e).__name__}
    return {"ok": True, "url": base, "models": models}


@router.get("/system/status")
async def system_status(db: Session = Depends(get_db), _=Depends(get_current_user)):
    s = get_settings()
    async with httpx.AsyncClient(timeout=PROBE_TIMEOUT, verify=s.comfy_verify_tls) as comfy_client, \
            httpx.AsyncClient(timeout=PROBE_TIMEOUT) as llm_client:
        comfy_results, llm = await asyncio.gather(
            asyncio.gather(*[_probe_comfy(comfy_client, u, s) for u in s.comfy_urls]),
            _probe_llm(llm_client, s),
        )

    # contract has a single comfy object; report the first healthy instance
    # TODO: expose every GPU instance once the UI has somewhere to show them
    if comfy_results:
        comfy = next((c for c in comfy_results if c["ok"]), comfy_results[0])
    else:
        comfy = {"ok": False, "url": "", "error": "COMFY_URLS is empty"}

    last = db.scalar(select(func.max(WorkerHeartbeat.last_seen)))
    worker = {"alive": bool(last and utcnow() - last <= WORKER_ALIVE_WINDOW)}
    if last:
        worker["last_heartbeat"] = _iso(last)

    return {"comfy": comfy, "llm": llm, "driver": s.gen_driver, "worker": worker}


@router.get("/system/comfy-check")
async def comfy_check(_=Depends(get_current_user)):
    """Validate every workflow template against the live server's /object_info."""
    from app.drivers.comfy_client import pick_client
    from app.workflows import check_template, list_templates

    s = get_settings()
    try:
        client = await pick_client(s.comfy_urls, s.comfy_auth_token, s.comfy_verify_tls)
    except Exception as e:
        return {"ok": False, "url": "", "error": str(e), "templates": {}}
    try:
        info = await client.object_info()
    except Exception as e:
        return {"ok": False, "url": client.base_url, "error": f"object_info failed: {e}", "templates": {}}
    finally:
        await client.close()
    templates = {name: check_template(name, info) for name in list_templates()}
    return {"ok": all(t["ok"] for t in templates.values()), "url": client.base_url, "templates": templates}


@router.get("/system/upscale-options")
async def upscale_options(generation_id: str | None = None, db: Session = Depends(get_db),
                          cur: CurrentUser = Depends(get_current_user)):
    """Engines with availability from the template checks; with generation_id, sizes and GPU estimates
    for that video (or image) at each target."""
    from app import upscale, upscale_image

    g = None
    if generation_id:
        g = db.get(Generation, generation_id)
        if g is None or g.workspace_id != cur.workspace_id:
            raise HTTPException(404, "Generation not found")
    s = get_settings()
    info, error = (None, None) if s.gen_driver == "mock" else await upscale.fetch_object_info()
    try:
        if g is not None and upscale_image.is_image(g):
            return upscale_image.options_for(g, info, driver=s.gen_driver, error=error)
        measured = upscale.measured_rates(db)
        out = upscale.engine_options(info, driver=s.gen_driver, measured=measured, error=error)
        out["media"] = "video"
        if g is not None:
            out.update(upscale.source_estimates(g, measured))
    except upscale.UpscaleError as e:
        raise HTTPException(422, str(e)) from None
    return out
