"""ORM models. Every domain row carries workspace_id so multi-tenant later is a filter, not a rewrite."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    # stored naive-UTC; SQLite has no tz type and mixing aware/naive bites on compare
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _id():
    return mapped_column(String(36), primary_key=True, default=new_id)


def _ws():
    return mapped_column(String(36), ForeignKey("workspace.id", ondelete="CASCADE"), index=True)


class Workspace(Base):
    __tablename__ = "workspace"
    id: Mapped[str] = _id()
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class User(Base):
    __tablename__ = "user"
    id: Mapped[str] = _id()
    email: Mapped[str] = mapped_column(String(320), unique=True)
    display_name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Membership(Base):
    __tablename__ = "membership"
    __table_args__ = (UniqueConstraint("user_id", "workspace_id"),)
    id: Mapped[str] = _id()
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("user.id", ondelete="CASCADE"), index=True)
    workspace_id: Mapped[str] = _ws()
    role: Mapped[str] = mapped_column(String(20), default="owner")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Project(Base):
    __tablename__ = "project"
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    title: Mapped[str] = mapped_column(String(300))
    logline: Mapped[str] = mapped_column(Text, default="")
    brief: Mapped[str] = mapped_column(Text, default="")
    authoring_mode: Mapped[str] = mapped_column(String(20))
    aspect_ratio: Mapped[str] = mapped_column(String(10), default="16:9")
    target_runtime_s: Mapped[int] = mapped_column(Integer, default=120)
    quality: Mapped[str] = mapped_column(String(10), default="draft")
    takes_per_shot: Mapped[int] = mapped_column(Integer, default=3)
    overnight: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    # look suffix every frame/motion prompt carries verbatim (world reconstruction)
    style_bible: Mapped[str] = mapped_column(Text, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, index=True)


class Scene(Base):
    __tablename__ = "scene"
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("project.id", ondelete="CASCADE"), index=True)
    # "order" is an SQL keyword; keep the attribute name the API uses
    order: Mapped[int] = mapped_column("sort_order", Integer, default=0)
    heading: Mapped[str] = mapped_column(String(300), default="")
    logline: Mapped[str] = mapped_column(Text, default="")
    script_text: Mapped[str] = mapped_column(Text, default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    time_of_day: Mapped[str | None] = mapped_column(String(20), nullable=True)
    mood: Mapped[str] = mapped_column(String(200), default="")
    lighting: Mapped[str] = mapped_column(String(200), default="")
    source: Mapped[str] = mapped_column(String(20), default="user")
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    stale: Mapped[bool] = mapped_column(Boolean, default=False)
    # no FK on purpose: adding one to an existing SQLite table means a table rebuild,
    # which with foreign_keys=ON cascades into scene_version. Cleared in code on delete.
    location_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class SceneVersion(Base):
    __tablename__ = "scene_version"
    __table_args__ = (UniqueConstraint("scene_id", "version"),)
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    scene_id: Mapped[str] = mapped_column(String(36), ForeignKey("scene.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    heading: Mapped[str] = mapped_column(String(300), default="")
    logline: Mapped[str] = mapped_column(Text, default="")
    script_text: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(20))
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Character(Base):
    __tablename__ = "character"
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("project.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(20), default="user")
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Location(Base):
    __tablename__ = "location"
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("project.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(20), default="user")
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    time_of_day_variants: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Shot(Base):
    __tablename__ = "shot"
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("project.id", ondelete="CASCADE"), index=True)
    scene_id: Mapped[str] = mapped_column(String(36), ForeignKey("scene.id", ondelete="CASCADE"), index=True)
    order: Mapped[int] = mapped_column("sort_order", Integer, default=0)
    shot_type: Mapped[str] = mapped_column(String(30), default="medium")
    duration_s: Mapped[float] = mapped_column(Float, default=4.0)
    description: Mapped[str] = mapped_column(Text, default="")
    camera: Mapped[str] = mapped_column(String(300), default="")
    prompt: Mapped[str] = mapped_column(Text, default="")
    prompt_mode: Mapped[str] = mapped_column(String(10), default="auto")
    start_prompt: Mapped[str] = mapped_column(Text, default="")
    end_prompt: Mapped[str] = mapped_column(Text, default="")
    motion_prompt: Mapped[str] = mapped_column(Text, default="")
    character_ids: Mapped[list] = mapped_column(JSON, default=list)
    location_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    seam_in: Mapped[str] = mapped_column(String(10), default="cut")
    handoff_text: Mapped[str] = mapped_column(Text, default="")
    # long-take beat list (migration 0004); owned by the long-take engine
    beats: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    stale: Mapped[bool] = mapped_column(Boolean, default=False)
    source: Mapped[str] = mapped_column(String(20), default="user")
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, index=True)


class Reel(Base):
    __tablename__ = "reel"
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("project.id", ondelete="CASCADE"), unique=True
    )
    title: Mapped[str] = mapped_column(String(300), default="", server_default="")
    settings: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, index=True)


class ReelClip(Base):
    __tablename__ = "reel_clip"
    __table_args__ = (UniqueConstraint("reel_id", "shot_id", name="uq_reel_clip_shot"),)
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    reel_id: Mapped[str] = mapped_column(String(36), ForeignKey("reel.id", ondelete="CASCADE"), index=True)
    shot_id: Mapped[str] = mapped_column(String(36), ForeignKey("shot.id", ondelete="CASCADE"))
    scene_id: Mapped[str] = mapped_column(String(36), ForeignKey("scene.id", ondelete="CASCADE"), index=True)
    # not an FK: takes are bulk-deleted with their shot; sync handles a dangling id
    generation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    order: Mapped[int] = mapped_column("sort_order", Integer, default=0)
    trim_in_s: Mapped[float] = mapped_column(Float, default=0.0)
    trim_out_s: Mapped[float] = mapped_column(Float, default=0.0)
    transition_in: Mapped[str] = mapped_column(String(12), default="cut")
    transition_s: Mapped[float] = mapped_column(Float, default=0.5)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    changed: Mapped[bool] = mapped_column(Boolean, default=False)
    source_duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, index=True)


class Generation(Base):
    __tablename__ = "generation"
    __table_args__ = (
        Index("ix_generation_target", "target_type", "target_id", "kind"),
        # backstop for the "one approved per target+kind" rule enforced in the API
        Index(
            "uq_generation_one_approved",
            "target_type", "target_id", "kind",
            unique=True,
            sqlite_where=text("status = 'approved'"),
            postgresql_where=text("status = 'approved'"),
        ),
    )
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    project_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("project.id", ondelete="CASCADE"), index=True, nullable=True
    )
    target_type: Mapped[str] = mapped_column(String(20))
    target_id: Mapped[str] = mapped_column(String(36))
    kind: Mapped[str] = mapped_column(String(30))
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    prompt: Mapped[str] = mapped_column(Text, default="")
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    seed: Mapped[int] = mapped_column(Integer, default=0)
    file_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    media_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    score: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    reject_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("generation.id", ondelete="SET NULL"), nullable=True
    )
    # not an FK: job.generation_id already points this way and SQLite dislikes cycles
    job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, index=True)


class Job(Base):
    __tablename__ = "job"
    __table_args__ = (Index("ix_job_status_created", "status", "created_at"),)
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    type: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    priority: Mapped[int] = mapped_column(Integer, default=0)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str] = mapped_column(String(500), default="")
    project_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("project.id", ondelete="CASCADE"), index=True, nullable=True
    )
    generation_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("generation.id", ondelete="SET NULL"), nullable=True
    )
    gpu: Mapped[str | None] = mapped_column(String(200), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, index=True)
    gpu_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)


class UsageLedger(Base):
    __tablename__ = "usage_ledger"
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    job_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("job.id", ondelete="SET NULL"), nullable=True)
    gpu_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    kind: Mapped[str] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class WorkerHeartbeat(Base):
    __tablename__ = "worker_heartbeat"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    last_seen: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    info: Mapped[dict] = mapped_column(JSON, default=dict)


class Suggestion(Base):
    """An AI edit the user hasn't accepted yet (PLAN 2b: suggestions, not silent edits)."""

    __tablename__ = "suggestion"
    __table_args__ = (Index("ix_suggestion_target", "target_type", "target_id", "status"),)
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("project.id", ondelete="CASCADE"), index=True)
    target_type: Mapped[str] = mapped_column(String(20))
    target_id: Mapped[str] = mapped_column(String(36))
    field: Mapped[str] = mapped_column(String(40))
    current_text: Mapped[str] = mapped_column(Text, default="")
    proposed_text: Mapped[str] = mapped_column(Text, default="")
    action: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    job_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("job.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class MediaItem(Base):
    """A standalone image or video (Image studio result, upload, standalone upscale). Contract v5.

    Its versions are generations with target_type="media", target_id=this id; generation_id is the
    current one. Project results show up in the Library as computed rows, never as MediaItems."""

    __tablename__ = "media_item"
    __table_args__ = (Index("ix_media_item_ws_created", "workspace_id", "created_at"),)
    id: Mapped[str] = _id()
    workspace_id: Mapped[str] = _ws()
    kind: Mapped[str] = mapped_column(String(10))  # image | video
    origin: Mapped[str] = mapped_column(String(20))  # generated | upload
    title: Mapped[str] = mapped_column(String(300), default="", server_default="")
    tags: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    project_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("project.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # not an FK, same reason as generation.job_id
    generation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    thumb_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, index=True)
