"""The ad campaign's stage machine (contract v36): concepts -> photos -> layout.

The Poetry Short pattern: the `ad_campaign` job writes the concepts inline (LLM), enqueues the photos as
generate jobs pointing back at it (parent_job_id) and defers itself until they land, then lays out every
ad on the CPU. Everything it knows is on the AdCampaign row, so a retry or the next "continue" carries on
where it stopped. With brief.review on it stops after the concepts for an OK.
"""
import copy
import logging
import time
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm.attributes import flag_modified

from app import aerab
from app import brand as br
from app import brand_templates as bt
from app import library as lib
from app import models_catalog as mc
from app import styles as st
from app.ads import copy as cp
from app.ads import service as svc
from app.autopilot import POLL_S, WAIT_PRIORITY, StageFailed, Wait
from app.llm import LLMError, chat_sync
from app.llm.prompts import AdConcepts, ad_concept_messages
from app.models import AdCampaign, Generation, Job, MediaItem
from app.services import enqueue_generation

log = logging.getLogger("mixai.ads")


def _w():
    from app import worker

    return worker


@dataclass
class Review:
    message: str


def copy_space(style: str, group: str, rtl: bool) -> str:
    side, other = ("right", "left") if rtl else ("left", "right")
    if style in ("frosted", "badge", "side_wash"):
        if group == "wide":
            return (f"Composition: the subject in the {other} half of the frame; the {side} half calm, softly lit "
                    "and uncluttered, with room for text.")
        return (f"Composition: the subject in the {other} part and lower half of the frame; the upper {side} "
                "area calm, softly lit and uncluttered, with room for text.")
    if style == "bottom_bar":
        return "Composition: the subject in the upper two thirds, nothing important in the bottom third."
    if style == "split":
        return "Composition: the subject centred and close, filling the frame."
    return "Composition: the subject low in the frame, a large calm empty area in the upper half for text."


class Run:
    def __init__(self, ctx):
        self.ctx, self.db, self.job = ctx, ctx.db, ctx.job
        p = self.job.payload or {}
        self.c = self.db.get(AdCampaign, p.get("ad_campaign_id") or "")
        if self.c is None or self.c.workspace_id != self.job.workspace_id:
            raise svc.AdError("This ad campaign no longer exists")
        self.kit = svc.kit_of(self.db, self.c)
        self.r = copy.deepcopy(self.job.result or {})
        self.current: str | None = None
        self.message = ""
        self.spins = 0

    @property
    def b(self) -> dict:
        return svc.brief_of(self.c)

    def rec(self) -> dict:
        return svc.stage(self.c, self.current)

    def put(self, rec: dict) -> None:
        svc.put_stage(self.c, self.current, rec)

    def save(self) -> None:
        self.r["stage"] = self.current
        self.job.result = copy.deepcopy(self.r)
        flag_modified(self.job, "result")

    def tick(self, frac: float = 0.0, message: str | None = None) -> None:
        if message is not None:
            self.message = message
        i = svc.STAGE_KEYS.index(self.current) if self.current in svc.STAGE_KEYS else 0
        label = dict(svc.STAGES).get(self.current or "", "")
        self.save()
        self.ctx.progress((i + max(0.0, min(1.0, frac))) / len(svc.STAGE_KEYS),
                          f"{label}: {self.message}" if label and self.message else self.message or label)

    def link(self, g: Generation) -> Generation:
        child = self.db.get(Job, g.job_id)
        child.payload = {**(child.payload or {}), "parent_job_id": self.job.id}
        return g

    def run(self) -> dict:
        for key in svc.STAGE_KEYS:
            self.current = key
            rec = self.rec()
            if rec.get("status") in ("done", "skipped"):
                continue
            reviewed = rec.get("status") == "review"
            self.c.stage = key
            rec.update(status="running", detail=None)
            self.put(rec)
            self.tick(0.0, "")
            while True:
                out = getattr(self, f"stage_{key}")(reviewed)
                if isinstance(out, Wait):
                    self.wait(out)
                    continue
                break
            rec = self.rec()
            if isinstance(out, Review):
                rec.update(status="review", detail=out.message)
                self.put(rec)
                self.r["waiting_on"] = []
                self.tick(1.0, out.message)
                return copy.deepcopy(self.r)
            rec.update(status="done", detail=out if isinstance(out, str) else rec.get("detail"))
            self.put(rec)
            self.tick(1.0, "")
        self.c.stage = "done"
        self.r["waiting_on"] = []
        self.save()
        return copy.deepcopy(self.r)

    def pending(self, ids: list[str]) -> list[str]:
        if not ids:
            return []
        return list(self.db.scalars(select(Job.id).where(Job.id.in_(ids), Job.status.in_(("queued", "running")))))

    def other_work_queued(self) -> bool:
        lanes = getattr(self.ctx, "lanes", None)
        lane_ok = [Job.lane.in_(lanes)] if lanes else []
        return bool(self.db.scalar(select(func.count()).select_from(Job).where(
            Job.status == "queued", Job.priority > WAIT_PRIORITY, Job.id != self.job.id, *lane_ok)))

    def wait(self, w: Wait) -> None:
        ids = list(dict.fromkeys(w.job_ids))
        self.r["waiting_on"] = ids
        self.tick(message=w.message)
        if not self.pending(ids):
            self.spins += 1
            if self.spins > 200:
                raise StageFailed("Stuck waiting for work that already finished; retry the job")
            return
        self.spins = 0
        if not self.other_work_queued():
            deadline = time.monotonic() + POLL_S
            while time.monotonic() < deadline:
                time.sleep(1.0)
                self.tick()
                if not self.pending(ids):
                    return
                if self.other_work_queued():
                    break
        self.db.commit()
        raise _w().JobDeferred(f"{dict(svc.STAGES)[self.current]}: {w.message}", priority=WAIT_PRIORITY)

    # ---------------------------------------------------------------- concepts
    def write(self, count: int, avoid: list[str] | None = None) -> list[dict]:
        b, c = self.b, self.c
        products = []
        for mid in b["product_media_ids"]:
            item = self.db.get(MediaItem, mid)
            products.append(item.title if item is not None and item.title else "the client's product")
        msgs = ad_concept_messages(brand=br.prompt_context(self.kit) if self.kit else "", subject=b["subject"],
                                   description=b["description"], brief=b["brief"], occasion=b["occasion"],
                                   market=b["market"], language=c.language, tone=b["tone"], must_say=b["must_say"],
                                   offers=b["offers"], count=count, products=products, rtl=svc.is_rtl(c.language),
                                   avoid=avoid, channels=self.channel_names())
        try:
            res = chat_sync("creative", msgs, schema=AdConcepts, think=False, temperature=0.85,
                            max_tokens=900 + 450 * count, tick=lambda: self.tick(0.1))
        except LLMError as e:
            raise StageFailed(f"The copywriter is offline: {e}") from e
        extra = " ".join([b["must_say"], b["subject"], b["description"], self.kit.name if self.kit else ""])
        channels = cp.channels_of(br.contact_of(self.kit), br.socials_of(self.kit))
        out = []
        for data in res.data.concepts[:count]:
            clean, report = cp.guard(data.model_dump(), b["offers"], extra, channels)
            if any(report.values()):
                log.info("ad campaign %s: guard took out %s", c.id, report)
            out.append((clean, report))
        if not out:
            raise StageFailed("The copywriter came back with no concepts")
        self.mark(out)
        return [{**d, "_guard": g} for d, g in out]

    def channel_names(self) -> list[str]:
        """The kit's channels as the copywriter hears of them: names only, the footer has the details."""
        contact, socials = br.contact_of(self.kit), br.socials_of(self.kit)
        names = [cp.PLATFORM_WORDS.get(s["platform"], s["platform"].title()) for s in socials]
        if contact.get("whatsapp"):
            names.append("WhatsApp")
        names += [label for k, label in (("phone", "phone"), ("website", "website"),
                                          ("booking_url", "online booking"), ("email", "email")) if contact.get(k)]
        return list(dict.fromkeys(names))

    def mark(self, rows: list[tuple[dict, dict]]) -> None:
        """Full aerab on everything the writer wrote, in one pass for the whole batch."""
        texts, where = [], []
        for i, (d, _) in enumerate(rows):
            for k in svc.TEXT_KEYS:
                for j, line in enumerate((d.get(k) or "").split("\n")):
                    if line.strip():
                        texts.append(line)
                        where.append((i, k, j))
        if not texts or not svc.wants_aerab(self.c, "\n".join(texts)):
            return
        self.tick(0.6, "Adding aerab")
        marked = aerab.finish_lines_sync(texts, self.c.language, tick=lambda: self.tick(0.6), what="ad copy")
        for (i, k, j), line in zip(where, marked):
            d = rows[i][0]
            parts = (d.get(k) or "").split("\n")
            parts[j] = line
            d[k] = "\n".join(parts)

    def stage_concepts(self, reviewed: bool):
        c = self.c
        if not c.concepts:
            self.tick(0.1, "Writing the concepts")
            rows = self.write(int(self.b["variants"]))
            c.concepts = [svc.new_concept(n, d, d.pop("_guard")) for n, d in enumerate(rows, 1)]
        for con in [dict(x) for x in c.concepts if x.get("copy_dirty")]:
            self.tick(0.3, f"Rewriting concept {con['n']}")
            d = self.write(1, avoid=[" ".join((con.get("headline") or "").split())])[0]
            g = d.pop("_guard")
            keep_photo = bool(con.get("photos"))
            for k in ("insight", "kicker", "headline", "body", "cta", "offers"):
                con[k] = d.get(k) or ([] if k == "offers" else "")
            if not keep_photo:
                for k in ("layout", "photo_prompt", "placement", "logo_surface"):
                    con[k] = d.get(k) or ""
            con.update(guard=g, copy_dirty=False, edited=False)
            svc.put_concept(c, con)
            svc.mark_dirty(c, con["id"])
        rec = self.rec()
        if reviewed or rec.get("approved"):
            rec["approved"] = True
            self.put(rec)
            return None
        if not self.b.get("review", True):
            return None
        return Review("Pick the concepts to make and edit any line, then continue")

    # ---------------------------------------------------------------- photos
    def wants_logo(self, con: dict) -> bt.LogoPick | None:
        if not (self.b.get("logo_on_surface") and (con.get("logo_surface") or "").strip() and self.kit):
            return None
        try:
            return bt.pick_logo(self.db, self.kit, "light")
        except HTTPException:  # no logo in the kit: the overlay logo is all there is
            return None

    def products(self) -> list[str]:
        ids = []
        for mid in self.b["product_media_ids"][:2]:
            g = br.media_generation(self.db, self.c.workspace_id, mid)
            if g is not None and (g.media_type or "").startswith("image/"):
                ids.append(g.id)
        return ids

    def photo_request(self, con: dict, group: str) -> tuple[str, dict]:
        b, c = self.b, self.c
        aspect = svc.group_aspect(group, b["formats"])
        w, h = lib.size_for_ratio(*(int(x) for x in aspect.split(":")))
        space = copy_space(con.get("layout") or "frosted", group, svc.is_rtl(c.language))
        scene = " ".join(f"{con.get('photo_prompt') or b['subject']} {space}".split())
        if self.kit is not None:
            scene = f"{scene} {br.image_prompt_suffix(self.kit)}".strip()
        base = {"aspect": aspect, "width": w, "height": h, "ad_campaign": c.id, "concept_id": con["id"],
                "photo_group": group, "created_by": {"user_id": c.created_by, "flow": "ad_studio"}}
        refs = self.products()
        if refs:
            # the real product goes into the scene: the edit model with the client's pictures as references
            m, chosen = mc.choose(mc.AUTO, "edit", scene, refs=len(refs))
            names = " and ".join(f"picture {i}" for i in range(1, len(refs) + 1))
            instruction = (f"A professional advertising photograph. {scene} The product from {names} is placed "
                           f"naturally in this scene ({con.get('placement') or 'as the hero of the frame'}): keep "
                           "its exact shape, colours, proportions and label exactly as in the reference, "
                           "photographed in the scene's light. No added text.")
            return instruction, {**base, "instruction": instruction, "reference_ids": refs, "model": m.id,
                                 "product_media_ids": b["product_media_ids"], **chosen}
        m, chosen = mc.choose(b["image_model"] or svc.DEFAULT_MODEL, "image", scene)
        speed = mc.speed_of(m, None) if m.speeds else None
        params = {**base, "model": m.id, "style": None, "user_prompt": scene, **chosen}
        if speed:
            params["speed"] = speed.id
        neg = st.joined_negative(svc.PHOTO_NEGATIVE, None, speed.cfg if speed else None)
        if neg:
            params["negative"] = neg
        return scene, params

    def logo_request(self, con: dict, base: Generation, logo: bt.LogoPick) -> tuple[str, dict]:
        surface = con.get("logo_surface")
        rule = bt.logo_rule(self.kit, logo, "white")
        text = (f"Put the {self.kit.name} logo from picture 2 on {surface} in picture 1, printed or applied the way "
                f"it would be in real life, following the surface's shape, light and texture. {rule} Change "
                "nothing else in picture 1.")
        m, chosen = mc.choose(mc.AUTO, "edit", text, refs=2)
        p = base.params or {}
        return text, {"aspect": p.get("aspect"), "width": p.get("width"), "height": p.get("height"),
                      "instruction": text, "reference_ids": [base.id, logo.generation_id], "model": m.id,
                      "ad_campaign": self.c.id, "concept_id": con["id"], "photo_group": p.get("photo_group"),
                      "logo_on_surface": surface, "brand": {"kit_id": self.kit.id},
                      "created_by": {"user_id": self.c.created_by, "flow": "ad_studio:logo"}, **chosen}

    def enqueue(self, con: dict, prompt: str, params: dict) -> Generation:
        return self.link(enqueue_generation(self.db, workspace_id=self.c.workspace_id, project_id=None,
                                            target_type="ad_photo", target_id=con["id"], kind="image",
                                            prompt=prompt, params=params))

    def stage_photos(self, _reviewed: bool):
        db, c = self.db, self.c
        waits, failed, ready, total = [], [], 0, 0
        for con in [dict(x) for x in c.concepts or [] if x.get("approved")]:
            photos = dict(con.get("photos") or {})
            for grp in svc.groups(self.b["formats"]):
                total += 1
                rec = dict(photos.get(grp) or {})
                g = db.get(Generation, rec.get("base") or "")
                if g is not None and g.status in svc.LIVE:
                    waits.append(g.job_id)
                    continue
                if g is None or g.status not in svc.FINISHED:
                    if g is not None and rec.get("tries", 0) >= svc.ATTEMPTS:
                        job = db.get(Job, g.job_id or "")
                        failed.append((con, (job.error if job else None) or "no picture came back"))
                        continue
                    prompt, params = self.photo_request(con, grp)
                    g = self.enqueue(con, prompt, params)
                    rec.update(base=g.id, tries=rec.get("tries", 0) + 1, logo=None, logo_tries=0, final=None,
                               note=None)
                    photos[grp] = rec
                    waits.append(g.job_id)
                    continue
                logo_gen = self.wants_logo(con) if rec.get("note") is None else None
                if logo_gen:
                    lg = db.get(Generation, rec.get("logo") or "")
                    if lg is not None and lg.status in svc.LIVE:
                        waits.append(lg.job_id)
                        continue
                    if lg is None or lg.status not in svc.FINISHED:
                        if lg is not None and rec.get("logo_tries", 0) >= svc.ATTEMPTS:
                            # the plain photo is a perfectly good ad; the overlay logo is still there
                            rec.update(final=g.id, note="The logo didn't take on the surface; the plain photo is used")
                            photos[grp] = rec
                            ready += 1
                            continue
                        prompt, params = self.logo_request(con, g, logo_gen)
                        lg = self.enqueue(con, prompt, params)
                        rec.update(logo=lg.id, logo_tries=rec.get("logo_tries", 0) + 1, final=None)
                        photos[grp] = rec
                        waits.append(lg.job_id)
                        continue
                    rec["final"] = lg.id
                else:
                    rec["final"] = g.id
                photos[grp] = rec
                ready += 1
            con["photos"] = photos
            svc.put_concept(c, con)
        if waits:
            return Wait(waits, f"{ready} of {total} photos ready")
        for con, why in failed:
            con = svc.concept(c, con["id"])
            con["error"] = f"The photo wouldn't come: {why}"[:500]
            svc.put_concept(c, con)
        if failed and ready == 0:
            db.commit()
            raise StageFailed(f"No photo came back: {failed[0][1]}")
        return f"{len(failed)} concept photo(s) failed" if failed else None

    # ---------------------------------------------------------------- layout
    def stage_layout(self, _reviewed: bool):
        c = self.c
        cons = [dict(x) for x in c.concepts or [] if x.get("approved")]
        made = 0
        for i, con in enumerate(cons):
            self.tick(i / max(1, len(cons)), f"Laying out concept {con['n']}")
            made += svc.render_concept(self.db, c, svc.concept(c, con["id"]), self.kit)
        svc.write_ad_json(self.db, c)
        svc.touch(c)
        self.r["ads_made"] = made
        if not any(a.get("status") == "ready" for a in c.ads or []):
            raise StageFailed("No ad could be laid out")
        return None


def handle(ctx) -> dict:
    W = _w()
    run = Run(ctx)
    try:
        return run.run()
    except (W.JobDeferred, W.WorkerStopping):
        raise
    except W.JobCancelled:
        run.db.rollback()
        c = run.db.get(AdCampaign, run.c.id)
        if c is not None and run.current:
            rec = svc.stage(c, run.current)
            if rec.get("status") == "running":
                rec.update(status="pending", detail="Cancelled")
                svc.put_stage(c, run.current, rec)
        run.db.commit()
        raise
    except Exception as e:
        log.exception("ad campaign %s failed in %s", run.c.id, run.current)
        run.db.rollback()
        msg = str(e) or type(e).__name__
        if isinstance(e, LLMError):
            msg = f"The AI couldn't be reached: {msg}"
        c = run.db.get(AdCampaign, run.c.id)
        if c is not None and run.current:
            rec = svc.stage(c, run.current)
            rec.update(status="failed", detail=msg[:500])
            svc.put_stage(c, run.current, rec)
        job = run.db.get(Job, run.job.id)
        job.result = {**(job.result or {}), "waiting_on": []}
        run.db.commit()
        label = dict(svc.STAGES).get(run.current or "", "Ad campaign")
        raise RuntimeError(msg if msg.startswith(label) else f"{label} failed: {msg}") from e
