from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.auth import AuthContext, require_role
from app.config import settings
from app.db import get_db
from app.ghl_sync import discover_and_save_fields, sync_agency, sync_all_agencies, upsert_from_webhook_payload
from app.models import Agency, LeaderboardContact

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/leaderboard", tags=["leaderboard"])


# ── date window helpers ────────────────────────────────────────────────────

_ET = ZoneInfo("America/New_York")


def _et_today() -> date:
    """Return today's date in US Eastern time (matches the business timezone)."""
    return datetime.now(_ET).date()


def _window(period: str) -> tuple[datetime, datetime]:
    today = _et_today()
    if period == "daily":
        # midnight ET → midnight ET next day, stored as UTC-aware
        start = datetime(today.year, today.month, today.day, tzinfo=_ET).astimezone(timezone.utc)
        end = start + timedelta(days=1)
    elif period == "weekly":
        monday = today - timedelta(days=today.weekday())
        start = datetime(monday.year, monday.month, monday.day, tzinfo=_ET).astimezone(timezone.utc)
        end = start + timedelta(days=7)
    elif period == "monthly":
        start = datetime(today.year, today.month, 1, tzinfo=_ET).astimezone(timezone.utc)
        if today.month == 12:
            end = datetime(today.year + 1, 1, 1, tzinfo=_ET).astimezone(timezone.utc)
        else:
            end = datetime(today.year, today.month + 1, 1, tzinfo=_ET).astimezone(timezone.utc)
    else:
        raise ValueError(f"Unknown period: {period}")
    return start, end


def _fmt_date(d: date) -> str:
    return d.strftime("%b %d")


# ── aggregation ────────────────────────────────────────────────────────────

def _build_period_data(
    db: Session,
    agency_ids: list[str],
    period: str,
) -> dict[str, Any]:
    start, end = _window(period)
    today = _et_today()

    # Period display strings
    if period == "daily":
        period_label = today.strftime("%B %d, %Y")
        start_str = end_str = period_label
    elif period == "weekly":
        week_start = today - timedelta(days=today.weekday())
        week_end = week_start + timedelta(days=6)
        start_str = _fmt_date(week_start)
        end_str = _fmt_date(week_end)
        period_label = f"{start_str} — {end_str}"
    else:  # monthly
        start_str = today.strftime("%b 1")
        end_str = today.strftime("%b") + " " + str(
            (datetime(today.year, today.month + 1, 1, tzinfo=timezone.utc) - timedelta(days=1)).day
            if today.month < 12
            else 31
        )
        period_label = today.strftime("%B %Y")

    preds = [
        LeaderboardContact.agency_id.in_(agency_ids),
        LeaderboardContact.ghl_date_added >= start,
        LeaderboardContact.ghl_date_added < end,
    ]

    # Leaders: group by agent_name, count deals, sum premium
    rows = db.execute(
        select(
            LeaderboardContact.agent_name,
            func.count(LeaderboardContact.id).label("deals"),
            func.coalesce(func.sum(LeaderboardContact.premium), 0).label("premium"),
        )
        .where(*preds)
        .group_by(LeaderboardContact.agent_name)
        .order_by(func.coalesce(func.sum(LeaderboardContact.premium), 0).desc(),
                  func.count(LeaderboardContact.id).desc(),
                  LeaderboardContact.agent_name)
    ).all()

    leaders = [
        {"name": r.agent_name or "Unknown", "deals": r.deals, "premium": float(r.premium)}
        for r in rows
    ]
    total_deals = sum(l["deals"] for l in leaders)
    total_premium = sum(l["premium"] for l in leaders)

    # Breakdown: by state
    state_rows = db.execute(
        select(
            LeaderboardContact.issue_state,
            func.count(LeaderboardContact.id).label("count"),
            func.coalesce(func.sum(LeaderboardContact.premium), 0).label("premium"),
        )
        .where(*preds, LeaderboardContact.issue_state != "")
        .group_by(LeaderboardContact.issue_state)
        .order_by(func.count(LeaderboardContact.id).desc())
        .limit(20)
    ).all()

    # Breakdown: by plan type
    plan_rows = db.execute(
        select(
            LeaderboardContact.plan_name,
            func.count(LeaderboardContact.id).label("count"),
            func.coalesce(func.sum(LeaderboardContact.premium), 0).label("premium"),
        )
        .where(*preds, LeaderboardContact.plan_name != "")
        .group_by(LeaderboardContact.plan_name)
        .order_by(func.count(LeaderboardContact.id).desc())
        .limit(20)
    ).all()

    return {
        "period": period,
        "start_date": start_str,
        "end_date": end_str,
        "period_label": period_label,
        "leaders": leaders,
        "total_deals": total_deals,
        "total_premium": total_premium,
        "breakdown": {
            "states": [
                {"label": r.issue_state, "count": r.count, "premium": float(r.premium)}
                for r in state_rows
            ],
            "plan_types": [
                {"label": r.plan_name, "count": r.count, "premium": float(r.premium)}
                for r in plan_rows
            ],
        },
    }


# ── main leaderboard endpoint ──────────────────────────────────────────────

@router.get("/{agency_slug}")
def get_leaderboard_by_slug(
    agency_slug: str,
    db: Session = Depends(get_db),
):
    """Public-facing leaderboard — no auth required (agents share the URL)."""
    if agency_slug == "all":
        agencies = db.execute(
            select(Agency).where(Agency.is_active == True)  # noqa: E712
        ).scalars().all()
        agency_ids = [a.id for a in agencies]
        agency_name = "All Agencies"
        primary_slug = "all"
    else:
        agency = db.execute(
            select(Agency).where(Agency.slug == agency_slug)
        ).scalar_one_or_none()
        if not agency:
            raise HTTPException(status_code=404, detail="Agency not found")
        agency_ids = [agency.id]
        agency_name = agency.name
        primary_slug = agency.slug

    if not agency_ids:
        raise HTTPException(status_code=404, detail="No agencies found")

    daily = _build_period_data(db, agency_ids, "daily")
    weekly = _build_period_data(db, agency_ids, "weekly")
    monthly = _build_period_data(db, agency_ids, "monthly")

    # Last sync time
    last_row = db.execute(
        select(LeaderboardContact.last_synced_at)
        .where(LeaderboardContact.agency_id.in_(agency_ids))
        .order_by(LeaderboardContact.last_synced_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    last_sync = last_row.isoformat() if last_row else None

    return {
        "agency_slug": primary_slug,
        "agency_name": agency_name,
        "daily": daily,
        "weekly": weekly,
        "monthly": monthly,
        "daily_breakdown": daily["breakdown"],
        "weekly_breakdown": weekly["breakdown"],
        "monthly_breakdown": monthly["breakdown"],
        "last_sync": last_sync,
    }


@router.get("")
def list_agencies_for_leaderboard(db: Session = Depends(get_db)):
    """Returns list of active agencies for the index page."""
    agencies = db.execute(
        select(Agency).where(Agency.is_active == True)  # noqa: E712
        .order_by(Agency.name)
    ).scalars().all()
    return [{"slug": a.slug, "name": a.name, "code": a.unl_prefix} for a in agencies]


# ── webhook (instant sync) ─────────────────────────────────────────────────

@router.post("/webhook/{agency_slug}")
async def ghl_webhook(
    agency_slug: str,
    payload: dict,
    token: Optional[str] = Query(None),
    x_ghl_signature: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """GHL workflow webhook — called instantly when a contact is created.

    Set up in GHL: Workflows → Action → Webhook → POST https://your-api.com/api/leaderboard/webhook/{agency_slug}?token={GHL_WEBHOOK_TOKEN}
    """
    # Token check if configured
    if settings.ghl_webhook_token:
        if token != settings.ghl_webhook_token:
            raise HTTPException(status_code=401, detail="Invalid webhook token")

    agency = db.execute(
        select(Agency).where(Agency.slug == agency_slug)
    ).scalar_one_or_none()
    if not agency:
        raise HTTPException(status_code=404, detail="Agency not found")

    try:
        row = upsert_from_webhook_payload(db, agency=agency, payload=payload)
        if row is None:
            return {"ok": True, "msg": "contact skipped (no agent_name or no id)"}
        log.info("Webhook upserted for %s (agent=%s)", agency_slug, row.agent_name)
        return {"ok": True, "contact_id": row.ghl_contact_id, "agent": row.agent_name}
    except Exception as e:
        log.exception("Webhook upsert failed for %s: %s", agency_slug, e)
        raise HTTPException(status_code=500, detail="Internal error processing webhook")


# ── admin sync endpoints ───────────────────────────────────────────────────

@router.post("/sync/{agency_slug}")
async def manual_sync(
    agency_slug: str,
    full: bool = Query(False),
    db: Session = Depends(get_db),
    ctx: AuthContext = Depends(require_role("super_admin")),
):
    """Super-admin: trigger immediate GHL sync for one agency."""
    agency = db.execute(
        select(Agency).where(Agency.slug == agency_slug)
    ).scalar_one_or_none()
    if not agency:
        raise HTTPException(status_code=404, detail="Agency not found")

    result = await sync_agency(db, agency, full=full)
    return {"ok": True, "agency": agency_slug, **result}


@router.post("/sync-all")
async def sync_all(
    db: Session = Depends(get_db),
    ctx: AuthContext = Depends(require_role("super_admin")),
):
    """Super-admin: trigger immediate GHL sync for all agencies."""
    result = await sync_all_agencies(db)
    return {"ok": True, "results": result}


@router.post("/discover-fields/{agency_slug}")
async def discover_fields(
    agency_slug: str,
    db: Session = Depends(get_db),
    ctx: AuthContext = Depends(require_role("super_admin")),
):
    """Super-admin: auto-discover GHL custom field IDs for an agency.

    Uses the agency's PIT token to query GHL for all custom fields and
    automatically maps Agent Name, Monthly Premium, Plan Name, etc.
    """
    agency = db.execute(
        select(Agency).where(Agency.slug == agency_slug)
    ).scalar_one_or_none()
    if not agency:
        raise HTTPException(status_code=404, detail="Agency not found")

    result = await discover_and_save_fields(db, agency)
    return {"ok": True, "agency": agency_slug, **result}


@router.post("/discover-fields-all")
async def discover_fields_all(
    db: Session = Depends(get_db),
    ctx: AuthContext = Depends(require_role("super_admin")),
):
    """Super-admin: auto-discover GHL field IDs for ALL agencies at once."""
    agencies = db.execute(
        select(Agency).where(
            Agency.is_active == True,  # noqa: E712
        )
    ).scalars().all()

    results = {}
    seen = set()
    for a in agencies:
        if not a.ghl_location_id or not a.ghl_pit_token_enc:
            continue
        if a.ghl_location_id in seen:
            continue
        seen.add(a.ghl_location_id)
        results[a.slug] = await discover_and_save_fields(db, a)

    return {"ok": True, "results": results}
