"""The ad campaign's stage machine (contract v36): concepts -> photos -> layout.

The Poetry Short pattern: the `ad_campaign` job writes the concepts inline (LLM), enqueues the photos as
generate jobs pointing back at it (parent_job_id) and defers itself until they land, then lays out every
ad on the CPU. Everything it knows is on the AdCampaign row, so a retry or the next "continue" carries on
where it stopped. With brief.review on it stops after the concepts for an OK.
"""
import copy
import logging
import re
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
from app.ads import colours as col
from app.ads import copy as cp
from app.ads import service as svc
from app.autopilot import POLL_S, WAIT_PRIORITY, StageFailed, Wait
from app.llm import LLMError, chat_sync
from app.llm.prompts import (AD_CHECK_FIELDS, AD_PHOTO_MODELS, AdConcepts, AdCopyCheck, ad_concept_messages,
                              ad_copy_check_messages, ad_copy_space)
from app.models import AdCampaign, Generation, Job, MediaItem
from app.services import enqueue_generation

log = logging.getLogger("mixai.ads")


def _w():
    from app import worker

    return worker


@dataclass
class Review:
    message: str


NO_TEXT = "No text, no letters, no numbers, no logos, no signs, no name badges anywhere in the picture."
LOOK = "Editorial lifestyle photograph, natural light, real textures, candid and unposed."


def copy_space(style: str, group: str, rtl: bool) -> str:
    """The composition clause: where the layout will set the copy, so the photo leaves that region calm."""
    side, other = ("right", "left") if rtl else ("left", "right")
    if style in ("frosted", "badge", "side_wash"):
        if group == "wide" or style == "side_wash":
            return (f"Composition: the subject in the {other} half of the frame; copy space in the {side} half, "
                    "calm, softly lit and uncluttered.")
        return (f"Composition: the subject in the {other} part and lower half of the frame; copy space in the "
                f"upper {side} area, calm, softly lit and uncluttered.")
    if style == "bottom_bar":
        return ("Composition: the subject in the upper two thirds; copy space in the bottom third, nothing "
                "important there.")
    if style == "split":
        return "Composition: the subject centred and close, filling the frame."
    return "Composition: the subject low in the frame; copy space in the upper half, large, calm and empty."


def brand_tokens(kit) -> list[str]:
    """Words an image model must never be handed: the brand's name, handles, site and email."""
    if kit is None:
        return []
    contact, socials = br.contact_of(kit), br.socials_of(kit)
    out = [kit.name or "", kit.tagline or ""]
    out += [s.get("handle") or "" for s in socials]
    out += [(s.get("handle") or "").lstrip("@") for s in socials]
    out += [contact.get(k) or "" for k in ("website", "booking_url", "email", "phone", "whatsapp")]
    return [t for t in dict.fromkeys(x.strip() for x in out) if len(t) > 1]


def brand_look(kit) -> str:
    """The kit's look for a photo prompt: colours by name, the style text with any codes named too."""
    if kit is None:
        return ""
    parts = []
    words = col.palette_words(kit.palette)
    if words:
        parts.append("subtle colour accents of " + " and ".join(words[:3]) + " in natural things in the scene")
    if kit.style_text:
        parts.append(col.scrub(kit.style_text, brand_tokens(kit)).rstrip("."))
    return ", ".join(p for p in parts if p)


def brand_context(kit) -> str:
    """The kit for the copywriter, with the palette as colour names: hex codes it sees end up in its photo
    prompts, and from there painted into the photos."""
    if kit is None:
        return ""
    text = br.prompt_context(kit)
    if kit.palette:
        text = re.sub(r"^Colour palette: .*$", lambda _: "Colour palette: " + col.palette_phrase(kit.palette), text,
                      count=1, flags=re.M)
    return col.HEX.sub(lambda m: col.colour_name(m.group(0)), text)


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
        self._writer: str | None | bool = False  # False: not looked up yet

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
        msgs = ad_concept_messages(brand=brand_context(self.kit), subject=b["subject"],
                                   description=b["description"], brief=b["brief"], occasion=b["occasion"],
                                   market=b["market"], language=c.language, tone=b["tone"], must_say=b["must_say"],
                                   offers=b["offers"], count=count, products=products, rtl=svc.is_rtl(c.language),
                                   avoid=avoid, channels=self.channel_names(),
                                   colours=col.palette_words(self.kit.palette) if self.kit else [])
        try:
            res = chat_sync("creative", msgs, schema=AdConcepts, think=False, temperature=0.85,
                            max_tokens=900 + 450 * count, tick=lambda: self.tick(0.1), model=self.writer())
        except LLMError as e:
            raise StageFailed(f"The copywriter is offline: {e}") from e
        extra = " ".join([b["must_say"], b["subject"], b["description"], self.kit.name if self.kit else ""])
        channels = cp.channels_of(br.contact_of(self.kit), br.socials_of(self.kit))
        rows = self.self_check([d.model_dump() for d in res.data.concepts[:count]])
        out = []
        for data in rows:
            clean, report = cp.guard(data, b["offers"], extra, channels)
            if any(report.values()):
                log.info("ad campaign %s: guard took out %s", c.id, report)
            out.append((clean, report))
        if not out:
            raise StageFailed("The copywriter came back with no concepts")
        self.mark(out)
        return [{**d, "_guard": g} for d, g in out]

    def writer(self) -> str | None:
        if self._writer is False:
            self._writer = svc.writer_model()
            if self._writer:
                self.r["copywriter"] = self._writer
        return self._writer or None

    def self_check(self, rows: list[dict]) -> list[dict]:
        """A native editor's pass over the fresh copy: every line scored, the ones that read as translated or
        stiff rewritten. The notes stay on the concept for the quality report. A failed check keeps the copy."""
        if not rows:
            return rows
        self.tick(0.4, "Checking the copy reads naturally")
        msgs = ad_copy_check_messages(language=self.c.language, market=self.b["market"], concepts=rows)
        try:
            res = chat_sync("creative", msgs, schema=AdCopyCheck, think=False, temperature=0.4,
                            max_tokens=400 + 260 * len(rows), tick=lambda: self.tick(0.4), model=self.writer())
        except LLMError as e:
            log.warning("ad campaign %s: the copy self-check failed (%s); keeping the first draft", self.c.id, e)
            for r in rows:
                r["copy_check"] = [{"field": "*", "score": None, "issue": "self-check unavailable"}]
            return rows
        out = [dict(r, copy_check=[]) for r in rows]
        for ln in res.data.lines:
            if not (1 <= ln.concept <= len(out)) or ln.field not in AD_CHECK_FIELDS:
                continue
            row = out[ln.concept - 1]
            before = (row.get(ln.field) or "").strip()
            if not before:
                continue
            # a model that writes the break as the two characters \n still means a break
            new = (ln.rewrite or "").replace("\\n", "\n").strip()
            note = {"field": ln.field, "score": ln.score, "issue": ln.issue.strip()[:160]}
            if ln.score <= 3 and new and new != before:
                note.update(before=before, after=new)
                row[ln.field] = new
            row["copy_check"].append(note)
        return out

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
            for k in ("insight", "kicker", "headline", "body", "cta", "offers", "copy_check"):
                con[k] = d.get(k) or ([] if k in ("offers", "copy_check") else "")
            if not keep_photo:
                for k in ("layout", "photo_prompt", "photo_model", "placement", "logo_surface"):
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
        tokens = brand_tokens(self.kit)
        # nothing the image model could paint as text: no hex codes, handles, links or the brand's name
        idea = col.scrub(con.get("photo_prompt") or b["subject"], tokens)
        look = brand_look(self.kit)
        scene = " ".join(f"{LOOK} {idea.rstrip('.')}. {space} {look + '.' if look else ''}".split())
        base = {"aspect": aspect, "width": w, "height": h, "ad_campaign": c.id, "concept_id": con["id"],
                "photo_group": group, "created_by": {"user_id": c.created_by, "flow": "ad_studio"}}
        refs = self.products()
        if refs:
            # the real product goes into the scene: the edit model with the client's pictures as references
            m, chosen = mc.choose(mc.AUTO, "edit", scene, refs=len(refs))
            names = " and ".join(f"picture {i}" for i in range(1, len(refs) + 1))
            where = col.scrub(con.get("placement") or "", tokens) or "as the hero of the frame"
            instruction = (f"A professional advertising photograph. {scene} The product from {names} is placed "
                           f"naturally in this scene ({where}): keep its exact shape, colours, proportions and label "
                           "exactly as in the reference, photographed in the scene's light. No other text, letters "
                           "or numbers anywhere: only the product's own label.")
            return instruction, {**base, "instruction": instruction, "reference_ids": refs, "model": m.id,
                                 "product_media_ids": b["product_media_ids"], **chosen}
        scene = f"{scene} {NO_TEXT}"
        m, chosen = self.photo_model(con, scene)
        speed = mc.speed_of(m, None) if m.speeds else None
        params = {**base, "model": m.id, "style": None, "user_prompt": scene, **chosen}
        if speed:
            params["speed"] = speed.id
        neg = st.joined_negative(svc.PHOTO_NEGATIVE, None, speed.cfg if speed else None)
        if neg:
            params["negative"] = neg
        return scene, params

    def photo_model(self, con: dict, scene: str):
        """The user's model when they picked one; on auto, the photoreal engine the concept asked for."""
        want = self.b["image_model"] or svc.AUTO_MODEL
        if want != svc.AUTO_MODEL:
            return mc.choose(want, "image", scene)
        pick = con.get("photo_model") if con.get("photo_model") in AD_PHOTO_MODELS else svc.DEFAULT_MODEL
        m = mc.MODELS.get(pick)
        if m is None or mc.hidden(m) or mc.known_unavailable(m):
            pick = svc.DEFAULT_MODEL
        m, chosen = mc.choose(pick, "image", scene)
        return m, {**chosen, "model_requested": svc.AUTO_MODEL,
                   "model_auto_reason": "Ad Studio: the photoreal engine this concept asked for"}

    def logo_request(self, con: dict, base: Generation, logo: bt.LogoPick) -> tuple[str, dict]:
        surface = col.scrub(con.get("logo_surface") or "", brand_tokens(self.kit))
        rule = col.scrub(bt.logo_rule(self.kit, logo, "white"), brand_tokens(self.kit))
        text = (f"Put the logo from picture 2 on {surface} in picture 1, printed or applied the way it would be in "
                f"real life, following the surface's shape, light and texture. {rule} Add no other text. Change "
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
