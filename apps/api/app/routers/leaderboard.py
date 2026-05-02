from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.auth import AuthContext, require_role
from app.db import get_db
from app.models import Agency, ImportRun, ImportRunStatus, PolicyReport

router = APIRouter(prefix="/api/leaderboard", tags=["leaderboard"])

# Classifications that count as "active"
_ACTIVE = ("active",)
# Classifications that count as "cancelled / terminated"
_CANCELLED = ("terminated", "lapsed")
# Classifications that count as "pending" pipeline
_PENDING = ("pending_new", "pending_payment", "pending_cancel", "future_effective")
# Used for effectuation-rate denominator (definitive = total minus pending/suspended)
_EXCL_DENOM = ("pending_new", "pending_payment", "pending_cancel", "future_effective", "suspended")


def _safe_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


@router.get("")
def get_leaderboard(
    agency_id: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    metric: str = Query("premium"),   # premium | active | total
    limit: int = Query(25, ge=1, le=100),
    db: Session = Depends(get_db),
    ctx: AuthContext = Depends(require_role("super_admin", "admin", "agent")),
):
    df = _safe_date(date_from)
    dt = _safe_date(date_to)

    # ── Scope ────────────────────────────────────────────────────────────────
    if ctx.role == "super_admin":
        if agency_id:
            agency_ids = [agency_id]
        else:
            rows = db.execute(select(Agency.id).where(Agency.is_active == True)).scalars().all()  # noqa: E712
            agency_ids = list(rows)
    else:
        agency_ids = [ctx.agency_id]

    if not agency_ids:
        return {"agents": [], "last_sync": None, "agency_list": []}

    # ── Base filter predicates ────────────────────────────────────────────────
    preds = [PolicyReport.agency_id.in_(agency_ids)]
    if df:
        preds.append(PolicyReport.issue_date >= df)
    if dt:
        preds.append(PolicyReport.issue_date <= dt)

    # ── Aggregate per agent ───────────────────────────────────────────────────
    total_col        = func.count(PolicyReport.id).label("total")
    active_col       = func.sum(case((PolicyReport.classification.in_(_ACTIVE), 1), else_=0)).label("active")
    premium_col      = func.coalesce(
        func.sum(case((PolicyReport.classification.in_(_ACTIVE), PolicyReport.annual_premium), else_=0)), 0
    ).label("active_premium")
    cancelled_col    = func.sum(case((PolicyReport.classification.in_(_CANCELLED), 1), else_=0)).label("cancelled")
    pending_col      = func.sum(case((PolicyReport.classification.in_(_PENDING), 1), else_=0)).label("pending")
    definitive_col   = func.sum(case((PolicyReport.classification.not_in(_EXCL_DENOM), 1), else_=0)).label("definitive")
    agency_name_col  = func.min(Agency.name).label("agency_name")

    stmt = (
        select(
            PolicyReport.wa_code,
            PolicyReport.agent_name,
            PolicyReport.agency_id,
            agency_name_col,
            total_col,
            active_col,
            premium_col,
            cancelled_col,
            pending_col,
            definitive_col,
        )
        .join(Agency, Agency.id == PolicyReport.agency_id)
        .where(*preds)
        .group_by(PolicyReport.wa_code, PolicyReport.agent_name, PolicyReport.agency_id)
    )

    rows = db.execute(stmt).all()

    # ── Build + rank ──────────────────────────────────────────────────────────
    agents = []
    for r in rows:
        total     = r.total or 0
        active    = r.active or 0
        premium   = float(r.active_premium or 0)
        cancelled = r.cancelled or 0
        definitive = max(r.definitive or 0, 1)

        eff_rate    = round((active / definitive) * 100, 1)
        cancel_rate = round((cancelled / definitive) * 100, 1)

        agents.append({
            "wa_code":       r.wa_code or "—",
            "agent_name":    r.agent_name or "—",
            "agency_id":     r.agency_id,
            "agency_name":   r.agency_name or "—",
            "total":         total,
            "active":        active,
            "active_premium": premium,
            "cancelled":     cancelled,
            "pending":       r.pending or 0,
            "effectuation_rate": eff_rate,
            "cancel_rate":   cancel_rate,
        })

    # Sort by chosen metric
    sort_key = {
        "premium": lambda a: a["active_premium"],
        "active":  lambda a: a["active"],
        "total":   lambda a: a["total"],
    }.get(metric, lambda a: a["active_premium"])

    agents.sort(key=sort_key, reverse=True)
    agents = agents[:limit]

    # Add rank
    for i, a in enumerate(agents):
        a["rank"] = i + 1

    # ── Last sync ─────────────────────────────────────────────────────────────
    last_run = db.execute(
        select(ImportRun.finished_at, ImportRun.source_file)
        .where(ImportRun.status == ImportRunStatus.succeeded)
        .order_by(ImportRun.finished_at.desc())
        .limit(1)
    ).first()
    last_sync = last_run.finished_at.isoformat() if last_run and last_run.finished_at else None
    last_file = last_run.source_file if last_run else None

    # ── Agency list for filter ────────────────────────────────────────────────
    agency_list = db.execute(
        select(Agency.id, Agency.name)
        .where(Agency.is_active == True)  # noqa: E712
        .order_by(Agency.name)
    ).all()

    return {
        "agents":      agents,
        "last_sync":   last_sync,
        "last_file":   last_file,
        "agency_list": [{"id": a.id, "name": a.name} for a in agency_list],
        "scope_agency_ids": agency_ids,
    }
