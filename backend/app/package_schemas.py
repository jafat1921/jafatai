"""Shapes for packages, subscriptions, grants, payments and the admin panel (contract v39)."""
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas import AdminUserOut, Out, Utc

Period = Literal["day", "week", "month", "year", "none"]
PackageKind = Literal["standard", "demo", "custom"]
SubStatus = Literal["active", "expired", "cancelled", "pending_payment"]
PayStatus = Literal["pending", "paid", "failed", "refunded"]


class PackageOut(Out):
    id: str
    slug: str | None
    name: str
    description: str
    price_pkr: int
    period: str
    days: int | None
    gpu_min_day: float | None
    gpu_min_month: float | None
    max_queued: int | None
    private_items: bool
    models: list[str] | None
    features: dict[str, bool]
    kind: str
    public: bool
    custom_for_user_id: str | None
    active: bool
    sort: int
    created_at: Utc
    updated_at: Utc
    # filled by the list: people on it right now
    subscribers: int = 0


class PackageIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    price_pkr: int = Field(default=0, ge=0, le=100_000_000)
    period: Period = "month"
    days: int | None = Field(default=None, ge=1, le=3650)
    gpu_min_day: float | None = Field(default=None, ge=0, le=100_000)
    gpu_min_month: float | None = Field(default=None, ge=0, le=10_000_000)
    max_queued: int | None = Field(default=None, ge=0, le=1000)
    private_items: bool = False
    models: list[str] | None = Field(default=None, max_length=200)
    features: dict[str, bool] = Field(default_factory=dict)
    kind: PackageKind = "standard"
    public: bool = False
    custom_for_user_id: str | None = None
    active: bool = True
    sort: int = Field(default=0, ge=-1000, le=1000)


class PackagePatch(BaseModel):
    """Only the fields sent change; null clears a limit (no limit)."""
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    price_pkr: int | None = Field(default=None, ge=0, le=100_000_000)
    period: Period | None = None
    days: int | None = Field(default=None, ge=1, le=3650)
    gpu_min_day: float | None = Field(default=None, ge=0, le=100_000)
    gpu_min_month: float | None = Field(default=None, ge=0, le=10_000_000)
    max_queued: int | None = Field(default=None, ge=0, le=1000)
    private_items: bool | None = None
    models: list[str] | None = Field(default=None, max_length=200)
    features: dict[str, bool] | None = None
    kind: PackageKind | None = None
    public: bool | None = None
    active: bool | None = None
    sort: int | None = Field(default=None, ge=-1000, le=1000)


class SubscriptionOut(Out):
    id: str
    user_id: str
    package_id: str
    package_name: str = ""
    user_email: str = ""
    starts_at: Utc
    ends_at: Utc | None
    status: str
    source: str
    notes: str
    granted_by: str | None
    created_at: Utc


class AssignIn(BaseModel):
    package_id: str
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    notes: str = Field(default="", max_length=1000)


class DemoIn(BaseModel):
    package_id: str | None = None
    # yes to a second demo, on purpose
    allow_repeat: bool = False
    notes: str = Field(default="", max_length=1000)


class ExtendIn(BaseModel):
    days: int | None = Field(default=None, ge=1, le=3650)
    ends_at: datetime | None = None


class GrantIn(BaseModel):
    gpu_min: float = Field(gt=0, le=100_000)
    reason: str = Field(default="", max_length=500)
    expires_at: datetime | None = None


class GrantOut(Out):
    id: str
    user_id: str
    gpu_min: float
    reason: str
    starts_at: Utc
    expires_at: Utc | None
    revoked_at: Utc | None
    granted_by: str | None
    created_at: Utc
    live: bool = False


class CustomPackageIn(PackageIn):
    kind: PackageKind = "custom"
    starts_at: datetime | None = None
    ends_at: datetime | None = None


class PaymentOut(Out):
    id: str
    user_id: str
    user_email: str = ""
    subscription_id: str | None
    package_id: str | None
    package_name: str = ""
    gateway: str
    amount_pkr: int
    status: str
    reference: str
    notes: str
    created_at: Utc
    updated_at: Utc


class PaymentDetail(PaymentOut):
    raw: dict[str, Any] | None = None


class PaymentIn(BaseModel):
    """A payment the admin records by hand (a bank transfer, cash). Gateways fill this in themselves in M19."""
    user_id: str
    amount_pkr: int = Field(ge=0, le=100_000_000)
    package_id: str | None = None
    subscription_id: str | None = None
    gateway: str = Field(default="manual", min_length=1, max_length=40)
    reference: str = Field(default="", max_length=200)
    status: PayStatus = "pending"
    notes: str = Field(default="", max_length=1000)


class PaymentMarkIn(BaseModel):
    status: Literal["paid", "refunded", "failed"]
    notes: str = Field(default="", max_length=1000)


class AdminUserDetail(BaseModel):
    user: AdminUserOut
    usage: dict[str, Any]
    limits_override: dict[str, float | int | None]
    subscription: SubscriptionOut | None
    subscriptions: list[SubscriptionOut]
    grants: list[GrantOut]
    payments: list[PaymentOut]
    recent_jobs: list[dict[str, Any]]
    had_demo: bool


class AuditOut(Out):
    id: str
    actor_user_id: str | None
    actor_email: str
    action: str
    target_type: str
    target_id: str | None
    detail: dict[str, Any]
    created_at: Utc
