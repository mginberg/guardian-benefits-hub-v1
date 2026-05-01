from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import AuthContext, require_role
from app.db import get_db
from app.models import Agency, PolicyReport
from app.schemas import PolicyBookPoliciesResponse, PolicyBookPolicyRow, PolicyBookSummaryResponse


router = APIRouter(prefix="/api/policy-book", tags=["policy_book"])


def _parse_date(val: str | None) -> date | None:
    if not val:
        return None
    try:
        return date.fromisoformat(val)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date: {val} (expected YYYY-MM-DD)")


@router.get("/summary", response_model=PolicyBookSummaryResponse)
def summary(
    start: str | None = None,
    end: str | None = None,
    agency_id: str | None = None,
    ctx: AuthContext = Depends(require_role("super_admin", "admin")),
    db: Session = Depends(get_db),
):
    start_dt = _parse_date(start)
    end_dt = _parse_date(end)

    agency_filter = agency_id.strip() if agency_id else None
    if ctx.role != "super_admin":
        agency_filter = ctx.agency_id

    base = select(PolicyReport)
    if agency_filter:
        base = base.where(PolicyReport.agency_id == agency_filter)
    if start_dt:
        base = base.where(PolicyReport.issue_date >= start_dt)
    if end_dt:
        base = base.where(PolicyReport.issue_date <= end_dt)

    total = db.execute(select(func.count()).select_from(base.subquery())).scalar() or 0
    total_prem = (
        db.execute(select(func.coalesce(func.sum(PolicyReport.annual_premium), 0.0)).select_from(base.subquery()))
        .scalar()
        or 0.0
    )

    # by agency
    q_agency = (
        select(
            Agency.slug,
            Agency.name,
            func.count(PolicyReport.id),
            func.coalesce(func.sum(PolicyReport.annual_premium), 0.0),
        )
        .join(PolicyReport, PolicyReport.agency_id == Agency.id)
        .group_by(Agency.slug, Agency.name)
        .order_by(func.coalesce(func.sum(PolicyReport.annual_premium), 0.0).desc())
    )
    if agency_filter:
        q_agency = q_agency.where(PolicyReport.agency_id == agency_filter)
    if start_dt:
        q_agency = q_agency.where(PolicyReport.issue_date >= start_dt)
    if end_dt:
        q_agency = q_agency.where(PolicyReport.issue_date <= end_dt)

    by_agency = [
        {"slug": slug, "name": name, "policies": int(cnt), "annual_premium": float(prem)}
        for slug, name, cnt, prem in db.execute(q_agency).all()
    ]

    # by classification
    q_class = (
        select(
            PolicyReport.classification,
            func.count(PolicyReport.id),
            func.coalesce(func.sum(PolicyReport.annual_premium), 0.0),
        )
        .group_by(PolicyReport.classification)
        .order_by(func.count(PolicyReport.id).desc())
    )
    if agency_filter:
        q_class = q_class.where(PolicyReport.agency_id == agency_filter)
    if start_dt:
        q_class = q_class.where(PolicyReport.issue_date >= start_dt)
    if end_dt:
        q_class = q_class.where(PolicyReport.issue_date <= end_dt)

    by_classification = [
        {"classification": cls or "unknown", "policies": int(cnt), "annual_premium": float(prem)}
        for cls, cnt, prem in db.execute(q_class).all()
    ]

    return PolicyBookSummaryResponse(
        total_policies=int(total),
        total_annual_premium=float(total_prem),
        by_agency=by_agency,
        by_classification=by_classification,
    )


@router.get("/policies", response_model=PolicyBookPoliciesResponse)
def policies(
    limit: int = 200,
    start: str | None = None,
    end: str | None = None,
    agency_id: str | None = None,
    ctx: AuthContext = Depends(require_role("super_admin", "admin")),
    db: Session = Depends(get_db),
):
    limit = max(1, min(int(limit or 200), 1000))
    start_dt = _parse_date(start)
    end_dt = _parse_date(end)

    agency_filter = agency_id.strip() if agency_id else None
    if ctx.role != "super_admin":
        agency_filter = ctx.agency_id

    q = (
        select(
            Agency.slug,
            Agency.name,
            PolicyReport.policy_number,
            PolicyReport.wa_code,
            PolicyReport.agent_name,
            PolicyReport.issue_date,
            PolicyReport.paid_to_date,
            PolicyReport.annual_premium,
            PolicyReport.classification,
        )
        .join(Agency, Agency.id == PolicyReport.agency_id)
        .order_by(PolicyReport.imported_at.desc())
        .limit(limit)
    )
    if agency_filter:
        q = q.where(PolicyReport.agency_id == agency_filter)
    if start_dt:
        q = q.where(PolicyReport.issue_date >= start_dt)
    if end_dt:
        q = q.where(PolicyReport.issue_date <= end_dt)

    rows = []
    for slug, name, policy_number, wa_code, agent_name, issue_date, paid_to_date, annual_premium, classification in db.execute(
        q
    ).all():
        rows.append(
            PolicyBookPolicyRow(
                agency_slug=slug,
                agency_name=name,
                policy_number=policy_number or "",
                wa_code=wa_code or "",
                agent_name=agent_name or "",
                issue_date=issue_date.isoformat() if issue_date else None,
                paid_to_date=paid_to_date.isoformat() if paid_to_date else None,
                annual_premium=float(annual_premium or 0.0),
                classification=classification or "unknown",
            )
        )

    return PolicyBookPoliciesResponse(rows=rows)

