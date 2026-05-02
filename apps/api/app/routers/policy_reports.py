from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, desc, func, select
from sqlalchemy.orm import Session

from app.auth import AuthContext, require_role
from app.db import get_db
from app.models import Agency, PolicyReport
from app.policy_classifier import CONTRACT_REASON_LABELS, REASON_CANONICAL, plan_label


router = APIRouter(prefix="/api/policy-reports", tags=["policy_reports"])


CLASSIFICATION_LABELS: dict[str, str] = {
    "active": "Active",
    "non_effectuated": "Non-Effectuated",
    "cancelled": "Cancelled",
    "terminated": "Terminated",
    "pending_new": "Pending (New)",
    "pending_payment": "Pending (Payment)",
    "pending_cancel": "Pending/Cancel",
    "future_effective": "Future Effective",
    "lapsed": "Lapsed",
    "suspended": "Suspended",
    "unknown": "Unknown",
}


def _resolve_agency_for_slug(db: Session, slug: str) -> Agency:
    agency = db.execute(select(Agency).where(Agency.slug == slug)).scalar_one_or_none()
    if not agency:
        raise HTTPException(status_code=404, detail="Agency not found")
    return agency


def _resolve_scope_agencies(
    *,
    db: Session,
    ctx: AuthContext,
    agency_slug: str,
    agency_id_override: Optional[str],
) -> tuple[Agency, list[Agency]]:
    """
    Scope logic:
    - admin: only their own agency
    - super_admin:
      - if agency_slug == "guardian" and no override → include all active agencies
      - else → include the agency resolved by slug or override
    """
    if ctx.role == "admin":
        agency = db.execute(select(Agency).where(Agency.id == ctx.agency_id)).scalar_one_or_none()
        if not agency:
            raise HTTPException(status_code=404, detail="Agency not found")
        return agency, [agency]

    if ctx.role != "super_admin":
        raise HTTPException(status_code=403, detail="Forbidden")

    primary = _resolve_agency_for_slug(db, agency_slug)

    if agency_id_override:
        override = db.execute(select(Agency).where(Agency.id == agency_id_override)).scalar_one_or_none()
        if not override:
            raise HTTPException(status_code=404, detail="Agency not found")
        return override, [override]

    if agency_slug == "guardian":
        agencies = db.execute(select(Agency).where(Agency.is_active == True)).scalars().all()
        return primary, agencies

    return primary, [primary]


def _apply_filters(
    stmt,
    *,
    agency_ids: list[str],
    date_from: Optional[date],
    date_to: Optional[date],
    agent_name: Optional[str],
):
    stmt = stmt.where(PolicyReport.agency_id.in_(agency_ids))
    if date_from:
        stmt = stmt.where(PolicyReport.issue_date.is_not(None), PolicyReport.issue_date >= date_from)
    if date_to:
        stmt = stmt.where(PolicyReport.issue_date.is_not(None), PolicyReport.issue_date <= date_to)
    if agent_name:
        stmt = stmt.where(func.lower(PolicyReport.agent_name).contains(agent_name.lower().strip()))
    return stmt


@router.get("/{agency_slug}/dashboard-stats")
def dashboard_stats(
    agency_slug: str,
    agency_id: Optional[str] = Query(None, description="Agency ID override for super_admins"),
    date_from: Optional[date] = Query(None, description="Filter by issue_date >= YYYY-MM-DD"),
    date_to: Optional[date] = Query(None, description="Filter by issue_date <= YYYY-MM-DD"),
    agent_name: Optional[str] = Query(None, description="Filter by agent name (case-insensitive contains)"),
    ctx: AuthContext = Depends(require_role("admin", "super_admin")),
    db: Session = Depends(get_db),
) -> dict:
    primary, agencies = _resolve_scope_agencies(
        db=db, ctx=ctx, agency_slug=agency_slug, agency_id_override=agency_id
    )
    agency_ids = [a.id for a in agencies]

    filters_active = bool(date_from or date_to or (agent_name and agent_name.strip()))

    # Distinct agent list for filter dropdown (bounded to 1k for safety)
    agents_stmt = _apply_filters(
        select(PolicyReport.agent_name)
        .where(PolicyReport.agent_name != "")
        .distinct()
        .order_by(PolicyReport.agent_name)
        .limit(1000),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=None,  # don't self-filter the options list
    )
    available_agents = [r[0] for r in db.execute(agents_stmt).all() if r and r[0]]

    # Buckets (counts + premium)
    buckets_stmt = _apply_filters(
        select(
            PolicyReport.classification,
            func.count().label("count"),
            func.coalesce(func.sum(PolicyReport.annual_premium), 0.0).label("annual_premium"),
        ).group_by(PolicyReport.classification),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    bucket_rows = db.execute(buckets_stmt).all()

    total_policies = int(sum(int(r.count) for r in bucket_rows))
    total_premium = float(sum(float(r.annual_premium or 0.0) for r in bucket_rows))

    buckets: dict[str, dict] = {}
    for r in bucket_rows:
        key = (r.classification or "unknown").strip() or "unknown"
        count = int(r.count or 0)
        annual_premium = float(r.annual_premium or 0.0)
        pct = round((count / total_policies * 100.0), 1) if total_policies else 0.0
        buckets[key] = {
            "count": count,
            "annual_premium": annual_premium,
            "label": CLASSIFICATION_LABELS.get(key, key),
            "pct": pct,
        }

    def bcount(key: str) -> int:
        return int(buckets.get(key, {}).get("count", 0))

    def bprem(key: str) -> float:
        return float(buckets.get(key, {}).get("annual_premium", 0.0))

    active_count = bcount("active")
    active_premium = bprem("active")
    avg_premium = round(active_premium / active_count, 2) if active_count else 0.0

    terminated_count = bcount("terminated")
    lapsed_count = bcount("lapsed")
    cancelled_count = terminated_count + lapsed_count
    non_effectuated_count = bcount("non_effectuated")
    suspended_count = bcount("suspended")

    pending_new_count = bcount("pending_new")
    pending_payment_count = bcount("pending_payment")
    pending_cancel_count = bcount("pending_cancel")
    future_effective_count = bcount("future_effective")

    pending_pipeline = pending_new_count + pending_payment_count + future_effective_count
    definitive = max(total_policies - pending_pipeline - suspended_count, 0)

    # Claim counts by agency + agent (avoid N+1 queries later)
    claim_by_agency_stmt = _apply_filters(
        select(
            PolicyReport.agency_id.label("agency_id"),
            func.count().label("count"),
        )
        .where(
            PolicyReport.classification.in_(["terminated", "lapsed"]),
            func.upper(func.coalesce(PolicyReport.cntrct_reason, "")) == "DC",
        )
        .group_by(PolicyReport.agency_id),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    claim_by_agency: dict[str, int] = {
        r.agency_id: int(r.count or 0) for r in db.execute(claim_by_agency_stmt).all()
    }
    claim_by_agent_stmt = _apply_filters(
        select(
            PolicyReport.agency_id.label("agency_id"),
            PolicyReport.agent_name.label("agent_name"),
            PolicyReport.wa_code.label("wa_code"),
            func.count().label("count"),
        )
        .where(
            PolicyReport.agent_name != "",
            PolicyReport.classification.in_(["terminated", "lapsed"]),
            func.upper(func.coalesce(PolicyReport.cntrct_reason, "")) == "DC",
        )
        .group_by(PolicyReport.agency_id, PolicyReport.agent_name, PolicyReport.wa_code),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    claim_by_agent: dict[tuple[str, str, str], int] = {
        (r.agency_id, r.agent_name or "", r.wa_code or ""): int(r.count or 0)
        for r in db.execute(claim_by_agent_stmt).all()
    }

    claim_count = int(sum(claim_by_agency.values()))
    cancelled_excl_claims_count = max(cancelled_count - claim_count, 0)

    effectuation_rate = round(active_count / definitive * 100.0, 1) if definitive else 0.0
    cancel_rate = round(cancelled_excl_claims_count / definitive * 100.0, 1) if definitive else 0.0
    non_effectuated_rate = (
        round(non_effectuated_count / definitive * 100.0, 1) if definitive else 0.0
    )

    # State distribution (active only, like legacy)
    states_stmt = _apply_filters(
        select(
            func.nullif(func.upper(func.coalesce(PolicyReport.issue_state, "")), "").label("state"),
            func.count().label("count"),
        )
        .where(func.coalesce(PolicyReport.issue_state, "") != "")
        .where(PolicyReport.classification == "active")
        .group_by("state")
        .order_by(desc("count")),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    states: dict[str, int] = {r.state: int(r.count) for r in db.execute(states_stmt).all() if r.state}

    # Monthly trend (issue_date month)
    month_key = func.to_char(func.date_trunc("month", PolicyReport.issue_date), "YYYY-MM")
    monthly_stmt = _apply_filters(
        select(
            month_key.label("month"),
            PolicyReport.classification.label("classification"),
            func.count().label("count"),
        )
        .where(PolicyReport.issue_date.is_not(None))
        .group_by("month", "classification")
        .order_by("month"),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    monthly_rows = db.execute(monthly_stmt).all()
    month_map: dict[str, dict[str, int]] = {}
    for r in monthly_rows:
        m = r.month
        if not m:
            continue
        cls = (r.classification or "unknown").strip() or "unknown"
        month_map.setdefault(m, {})
        month_map[m][cls] = month_map[m].get(cls, 0) + int(r.count or 0)

    def month_full_label(m: str) -> str:
        try:
            y, mm = m.split("-")
            return date(int(y), int(mm), 1).strftime("%b %Y")
        except Exception:
            return m

    monthly_trend = []
    for m in sorted(month_map.keys()):
        cls_counts = month_map[m]
        monthly_trend.append(
            {
                "month": m,
                "month_full": month_full_label(m),
                "total": sum(cls_counts.values()),
                "active": cls_counts.get("active", 0),
                "terminated": cls_counts.get("terminated", 0),
                "non_effectuated": cls_counts.get("non_effectuated", 0),
                "lapsed": cls_counts.get("lapsed", 0),
                "pending_new": cls_counts.get("pending_new", 0),
                "pending_payment": cls_counts.get("pending_payment", 0),
                "pending_cancel": cls_counts.get("pending_cancel", 0),
                "future_effective": cls_counts.get("future_effective", 0),
                "suspended": cls_counts.get("suspended", 0),
            }
        )

    # ── Reason breakdown (canonicalized) ─────────────────────────────────────
    reason_stmt = _apply_filters(
        select(
            func.upper(func.coalesce(PolicyReport.cntrct_reason, "")).label("code"),
            func.count().label("count"),
        )
        .where(func.coalesce(PolicyReport.cntrct_reason, "") != "")
        .group_by("code")
        .order_by(desc("count")),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    raw_reason_rows = db.execute(reason_stmt).all()
    reason_counts: dict[str, int] = {}
    for r in raw_reason_rows:
        code = (r.code or "").strip().upper()
        if not code:
            continue
        canonical = REASON_CANONICAL.get(code, code)
        reason_counts[canonical] = reason_counts.get(canonical, 0) + int(r.count or 0)
    reason_breakdown = sorted(
        [
            {"code": code, "label": CONTRACT_REASON_LABELS.get(code, code), "count": count}
            for code, count in reason_counts.items()
        ],
        key=lambda x: -x["count"],
    )

    # ── Product mix (plan_code x classification) ─────────────────────────────
    # NOTE: Boolean→int casting differs by dialect; use explicit CASE.
    product_stmt = _apply_filters(
        select(
            func.coalesce(func.upper(func.nullif(PolicyReport.plan_code, "")), "UNKNOWN").label("plan_code"),
            PolicyReport.classification.label("classification"),
            func.count().label("count"),
            func.coalesce(func.sum(PolicyReport.annual_premium), 0.0).label("annual_premium"),
            func.sum(
                case(
                    (
                        (PolicyReport.classification.in_(["terminated", "lapsed"]))
                        & (func.upper(func.coalesce(PolicyReport.cntrct_reason, "")) == "DC"),
                        1,
                    ),
                    else_=0,
                )
            ).label("claim_count"),
        )
        .group_by("plan_code", "classification"),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    product_rows = db.execute(product_stmt).all()
    product_map: dict[str, dict] = {}
    for r in product_rows:
        code = (r.plan_code or "UNKNOWN").strip().upper() or "UNKNOWN"
        product_map.setdefault(
            code,
            {
                "plan_code": code,
                "plan_name": plan_label(code),
                "total": 0,
                "active": 0,
                "pending_new": 0,
                "pending_payment": 0,
                "pending_cancel": 0,
                "future_effective": 0,
                "terminated": 0,
                "non_effectuated": 0,
                "lapsed": 0,
                "suspended": 0,
                "active_premium": 0.0,
                "claim_count": 0,
            },
        )
        cls = (r.classification or "unknown").strip() or "unknown"
        count = int(r.count or 0)
        prem = float(r.annual_premium or 0.0)
        product_map[code]["total"] += count
        if cls in product_map[code]:
            product_map[code][cls] += count
        if cls == "active":
            product_map[code]["active_premium"] += prem
        product_map[code]["claim_count"] += int(r.claim_count or 0)
    product_mix = []
    for s in product_map.values():
        pending = int(s["pending_new"]) + int(s["pending_payment"]) + int(s["future_effective"])
        definitive_p = int(s["total"]) - pending - int(s["suspended"])
        cancelled_p = int(s["terminated"]) + int(s["lapsed"])
        cancelled_excl_claims_p = max(cancelled_p - int(s["claim_count"]), 0)
        ne_p = int(s["non_effectuated"]) + int(s["pending_cancel"])
        product_mix.append(
            {
                **s,
                "active_premium": round(float(s["active_premium"]), 2),
                "effectuation_rate": round(int(s["active"]) / definitive_p * 100.0, 1) if definitive_p > 0 else 0.0,
                "cancel_rate": round(cancelled_excl_claims_p / definitive_p * 100.0, 1) if definitive_p > 0 else 0.0,
                "non_effectuated_rate": round(ne_p / definitive_p * 100.0, 1) if definitive_p > 0 else 0.0,
            }
        )
    product_mix.sort(key=lambda x: -int(x.get("total", 0)))

    # ── Underwriting speed (app_received_date -> issue_date) ─────────────────
    # Postgres DATE subtraction yields an integer day count.
    uw_days = (PolicyReport.issue_date - PolicyReport.app_received_date).label("days")
    uw_base = _apply_filters(
        select(uw_days, PolicyReport.issue_date),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    ).where(
        PolicyReport.issue_date.is_not(None),
        PolicyReport.app_received_date.is_not(None),
        PolicyReport.issue_date >= PolicyReport.app_received_date,
    )
    uw_count = int(db.execute(select(func.count()).select_from(uw_base.subquery())).scalar() or 0)
    uw_avg_days = float(
        db.execute(select(func.coalesce(func.avg(uw_days), 0.0)).select_from(uw_base.subquery())).scalar() or 0.0
    )
    uw_avg_days = round(uw_avg_days, 1)
    uw_bucket_stmt = _apply_filters(
        select(
            case(
                (uw_days == 0, "Same day"),
                (uw_days <= 3, "1-3 days"),
                (uw_days <= 7, "4-7 days"),
                (uw_days <= 14, "8-14 days"),
                (uw_days <= 30, "15-30 days"),
                else_="31+ days",
            ).label("bucket"),
            func.count().label("count"),
        )
        .where(
            PolicyReport.issue_date.is_not(None),
            PolicyReport.app_received_date.is_not(None),
            PolicyReport.issue_date >= PolicyReport.app_received_date,
        )
        .group_by("bucket")
        .order_by(desc("count")),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    uw_distribution: dict[str, int] = {r.bucket: int(r.count or 0) for r in db.execute(uw_bucket_stmt).all() if r.bucket}
    uw_month_key = func.to_char(func.date_trunc("month", PolicyReport.issue_date), "YYYY-MM")
    uw_monthly_stmt = _apply_filters(
        select(
            uw_month_key.label("month_key"),
            func.to_char(func.date_trunc("month", PolicyReport.issue_date), "Mon").label("month"),
            func.to_char(func.date_trunc("month", PolicyReport.issue_date), "Mon YYYY").label("month_full"),
            func.avg(uw_days).label("avg_days"),
            func.count().label("count"),
        )
        .where(
            PolicyReport.issue_date.is_not(None),
            PolicyReport.app_received_date.is_not(None),
            PolicyReport.issue_date >= PolicyReport.app_received_date,
        )
        .group_by("month_key", "month", "month_full")
        .order_by("month_key"),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    uw_monthly = [
        {
            "month": r.month,
            "month_full": r.month_full,
            "avg_days": round(float(r.avg_days or 0.0), 1),
            "count": int(r.count or 0),
        }
        for r in db.execute(uw_monthly_stmt).all()
    ]
    underwriting_speed = {
        "avg_days": uw_avg_days,
        "sample_size": uw_count,
        "distribution": uw_distribution,
        "monthly": uw_monthly,
    }

    # ── Reinstatement ────────────────────────────────────────────────────────
    reinstated_stmt = _apply_filters(
        select(func.count())
        .where(func.upper(func.coalesce(PolicyReport.cntrct_reason, "")).in_(["RS", "RE"])),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    reinstated_count = int(db.execute(reinstated_stmt).scalar() or 0)
    reinstatable_pool = terminated_count + lapsed_count + non_effectuated_count + pending_cancel_count
    ever_cancelled_pool = reinstated_count + reinstatable_pool
    reinstatement = {
        "count": reinstated_count,
        "pool": ever_cancelled_pool,
        "rate": round(reinstated_count / ever_cancelled_pool * 100.0, 1) if ever_cancelled_pool else 0.0,
    }

    # ── Cancellation deep-dive (aggregate + small detail sample) ─────────────
    off_books = ["terminated", "lapsed", "non_effectuated", "pending_cancel"]
    days_on_books = func.coalesce(PolicyReport.paid_to_date - PolicyReport.issue_date, 0)
    cancel_agg_stmt = _apply_filters(
        select(
            func.count().label("pool"),
            func.avg(days_on_books).label("avg_days"),
            func.sum(case((days_on_books == 0, 1), else_=0)).label("never_started"),
            func.sum(case((days_on_books > 0, 1), else_=0)).label("paid_then_cancelled"),
            func.sum(case((days_on_books <= 30, 1), else_=0)).label("b_1_30"),
            func.sum(case(((days_on_books >= 31) & (days_on_books <= 60), 1), else_=0)).label("b_31_60"),
            func.sum(case(((days_on_books >= 61) & (days_on_books <= 90), 1), else_=0)).label("b_61_90"),
            func.sum(case((days_on_books >= 91, 1), else_=0)).label("b_91p"),
        ).where(PolicyReport.classification.in_(off_books)),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    cancel_agg = db.execute(cancel_agg_stmt).first()
    avg_days_on_books = round(float(cancel_agg.avg_days or 0.0), 1) if cancel_agg else 0.0
    cancellation = {
        "never_started": int(cancel_agg.never_started or 0) if cancel_agg else 0,
        "paid_then_cancelled": int(cancel_agg.paid_then_cancelled or 0) if cancel_agg else 0,
        "avg_days_on_books": avg_days_on_books,
        "days_buckets": {
            "0 days (Never Started)": int(cancel_agg.never_started or 0) if cancel_agg else 0,
            "1-30 days": int(cancel_agg.b_1_30 or 0) if cancel_agg else 0,
            "31-60 days": int(cancel_agg.b_31_60 or 0) if cancel_agg else 0,
            "61-90 days": int(cancel_agg.b_61_90 or 0) if cancel_agg else 0,
            "91+ days": int(cancel_agg.b_91p or 0) if cancel_agg else 0,
        },
        "detail": [],
    }
    cancel_detail_stmt = _apply_filters(
        select(
            PolicyReport.agent_name,
            PolicyReport.policy_number,
            PolicyReport.issue_date,
            PolicyReport.paid_to_date,
            days_on_books.label("days_on_books"),
            PolicyReport.classification,
            PolicyReport.annual_premium,
            PolicyReport.issue_state,
            PolicyReport.wa_code,
        )
        .where(PolicyReport.classification.in_(off_books))
        .order_by(desc(days_on_books))
        .limit(100),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    cancellation["detail"] = [
        {
            "agent_name": r.agent_name or "",
            "policy_number": r.policy_number,
            "issue_date": r.issue_date.isoformat() if r.issue_date else None,
            "paid_to_date": r.paid_to_date.isoformat() if r.paid_to_date else None,
            "days_on_books": int(r.days_on_books or 0),
            "months": round(int(r.days_on_books or 0) / 30.44, 1),
            "classification": r.classification,
            "classification_label": CLASSIFICATION_LABELS.get(r.classification, r.classification),
            "annual_premium": float(r.annual_premium or 0.0),
            "issue_state": r.issue_state or "",
            "wa_code": r.wa_code or "",
        }
        for r in db.execute(cancel_detail_stmt).all()
    ]

    # Agency breakdown (counts by classification + premium)
    agency_bucket_stmt = _apply_filters(
        select(
            PolicyReport.agency_id,
            PolicyReport.classification,
            func.count().label("count"),
            func.coalesce(func.sum(PolicyReport.annual_premium), 0.0).label("annual_premium"),
        ).group_by(PolicyReport.agency_id, PolicyReport.classification),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    agency_bucket_rows = db.execute(agency_bucket_stmt).all()
    agency_meta = {a.id: a for a in agencies}
    agency_map: dict[str, dict] = {}
    for r in agency_bucket_rows:
        a_id = r.agency_id
        cls = (r.classification or "unknown").strip() or "unknown"
        agency_map.setdefault(
            a_id,
            {
                "id": a_id,
                "code": (agency_meta.get(a_id).unl_prefix or "").strip(),
                "name": agency_meta.get(a_id).name if agency_meta.get(a_id) else a_id,
                "slug": agency_meta.get(a_id).slug if agency_meta.get(a_id) else "",
                "counts": {},
                "active_premium": 0.0,
                "total": 0,
            },
        )
        count = int(r.count or 0)
        prem = float(r.annual_premium or 0.0)
        agency_map[a_id]["counts"][cls] = agency_map[a_id]["counts"].get(cls, 0) + count
        agency_map[a_id]["total"] += count
        if cls == "active":
            agency_map[a_id]["active_premium"] += prem

    agencies_out = []
    for a_id, payload in agency_map.items():
        c = payload["counts"]
        a_total = int(payload["total"])
        a_active = int(c.get("active", 0))
        a_terminated = int(c.get("terminated", 0))
        a_lapsed = int(c.get("lapsed", 0))
        a_ne = int(c.get("non_effectuated", 0))
        a_pending_new = int(c.get("pending_new", 0))
        a_pending_payment = int(c.get("pending_payment", 0))
        a_future = int(c.get("future_effective", 0))
        a_pending_cancel = int(c.get("pending_cancel", 0))
        a_suspended = int(c.get("suspended", 0))
        a_pending = a_pending_new + a_pending_payment + a_future
        a_definitive = max(a_total - a_pending - a_suspended, 0)

        a_claim = int(claim_by_agency.get(a_id, 0))
        a_cancelled = a_terminated + a_lapsed
        a_cancelled_excl = max(a_cancelled - a_claim, 0)

        agencies_out.append(
            {
                "id": a_id,
                "code": payload["code"] or payload["slug"] or a_id[:6],
                "name": payload["name"],
                "slug": payload["slug"],
                "total": a_total,
                "active": a_active,
                "pending_new": a_pending_new,
                "pending_payment": a_pending_payment,
                "future_effective": a_future,
                "terminated": a_terminated,
                "non_effectuated": a_ne,
                "pending_cancel": a_pending_cancel,
                "lapsed": a_lapsed,
                "suspended": a_suspended,
                "pending": a_pending,
                "active_premium": round(float(payload["active_premium"]), 2),
                "effectuation_rate": round(a_active / a_definitive * 100.0, 1) if a_definitive else 0.0,
                "cancel_rate": round(a_cancelled_excl / a_definitive * 100.0, 1) if a_definitive else 0.0,
                "non_effectuated_rate": round(a_ne / a_definitive * 100.0, 1) if a_definitive else 0.0,
            }
        )
    agencies_out.sort(key=lambda a: a.get("active_premium", 0.0), reverse=True)

    # Agent breakdown
    agent_stmt = _apply_filters(
        select(
            PolicyReport.agent_name,
            PolicyReport.wa_code,
            PolicyReport.agency_id,
            PolicyReport.classification,
            func.count().label("count"),
            func.coalesce(func.sum(PolicyReport.annual_premium), 0.0).label("annual_premium"),
        )
        .where(PolicyReport.agent_name != "")
        .group_by(
            PolicyReport.agent_name,
            PolicyReport.wa_code,
            PolicyReport.agency_id,
            PolicyReport.classification,
        ),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    agent_rows = db.execute(agent_stmt).all()
    agent_map: dict[tuple[str, str, str], dict] = {}
    for r in agent_rows:
        key = (r.agent_name or "", r.wa_code or "", r.agency_id or "")
        agent_map.setdefault(
            key,
            {
                "agent_name": r.agent_name or "",
                "wa_code": r.wa_code or "",
                "agency_id": r.agency_id or "",
                "agency_code": (agency_meta.get(r.agency_id).unl_prefix or "").strip()
                if agency_meta.get(r.agency_id)
                else "",
                "agency_name": agency_meta.get(r.agency_id).name if agency_meta.get(r.agency_id) else "",
                "counts": {},
                "active_premium": 0.0,
                "total": 0,
            },
        )
        cls = (r.classification or "unknown").strip() or "unknown"
        count = int(r.count or 0)
        prem = float(r.annual_premium or 0.0)
        agent_map[key]["counts"][cls] = agent_map[key]["counts"].get(cls, 0) + count
        agent_map[key]["total"] += count
        if cls == "active":
            agent_map[key]["active_premium"] += prem

    agents_out = []
    for payload in agent_map.values():
        c = payload["counts"]
        a_total = int(payload["total"])
        a_active = int(c.get("active", 0))
        a_terminated = int(c.get("terminated", 0))
        a_lapsed = int(c.get("lapsed", 0))
        a_ne = int(c.get("non_effectuated", 0))
        a_pending_new = int(c.get("pending_new", 0))
        a_pending_payment = int(c.get("pending_payment", 0))
        a_future = int(c.get("future_effective", 0))
        a_pending_cancel = int(c.get("pending_cancel", 0))
        a_suspended = int(c.get("suspended", 0))
        a_pending = a_pending_new + a_pending_payment + a_future
        a_definitive = max(a_total - a_pending - a_suspended, 0)

        a_claim = int(
            claim_by_agent.get((payload["agency_id"], payload["agent_name"], payload["wa_code"]), 0)
        )
        a_cancelled = a_terminated + a_lapsed
        a_cancelled_excl = max(a_cancelled - a_claim, 0)

        agents_out.append(
            {
                "agent_name": payload["agent_name"],
                "wa_code": payload["wa_code"],
                "agency_code": payload["agency_code"],
                "agency_name": payload["agency_name"],
                "total": a_total,
                "active": a_active,
                "pending": a_pending,
                "terminated": a_terminated,
                "non_effectuated": a_ne,
                "pending_cancel": a_pending_cancel,
                "lapsed": a_lapsed,
                "suspended": a_suspended,
                "active_premium": round(float(payload["active_premium"]), 2),
                "effectuation_rate": round(a_active / a_definitive * 100.0, 1) if a_definitive else 0.0,
                "cancel_rate": round(a_cancelled_excl / a_definitive * 100.0, 1) if a_definitive else 0.0,
                "non_effectuated_rate": round(a_ne / a_definitive * 100.0, 1) if a_definitive else 0.0,
            }
        )
    agents_out.sort(key=lambda a: a.get("active_premium", 0.0), reverse=True)

    # Last import metadata (best-effort)
    last_stmt = select(PolicyReport.source_file, PolicyReport.imported_at).where(
        PolicyReport.agency_id.in_(agency_ids)
    )
    last_stmt = last_stmt.order_by(desc(PolicyReport.imported_at)).limit(1)
    last = db.execute(last_stmt).first()
    last_import_file = last[0] if last else None
    last_import_at = (last[1].isoformat() if last and last[1] else None)

    report_date = date.today().isoformat()

    return {
        "agency_slug": primary.slug,
        "agency_name": primary.name,
        "total_policies": total_policies,
        "active_count": active_count,
        "active_premium": round(active_premium, 2),
        "avg_premium": avg_premium,
        "total_premium": round(total_premium, 2),
        "effectuation_rate": effectuation_rate,
        "cancel_rate": cancel_rate,
        "non_effectuated_rate": non_effectuated_rate,
        "cancelled_count": cancelled_count,
        "cancelled_excl_claims_count": cancelled_excl_claims_count,
        "claim_count": claim_count,
        "terminated_count": terminated_count,
        "non_effectuated_count": non_effectuated_count,
        "lapsed_count": lapsed_count,
        "suspended_count": suspended_count,
        "pending_pipeline": pending_pipeline,
        "pending_new_count": pending_new_count,
        "pending_payment_count": pending_payment_count,
        "pending_cancel_count": pending_cancel_count,
        "future_effective_count": future_effective_count,
        "definitive": definitive,
        "filters_active": filters_active,
        "filter_date_from": date_from.isoformat() if date_from else None,
        "filter_date_to": date_to.isoformat() if date_to else None,
        "filter_agent_name": agent_name.strip() if agent_name else None,
        "available_agents": available_agents,
        "buckets": buckets,
        "agencies": agencies_out,
        "agents": agents_out,
        "monthly_trend": monthly_trend,
        "states": states,
        "reason_breakdown": reason_breakdown,
        "product_mix": product_mix,
        "underwriting_speed": underwriting_speed,
        "reinstatement": reinstatement,
        "cancellation": cancellation,
        "last_import_file": last_import_file,
        "last_import_at": last_import_at,
        "report_date": report_date,
        "source": "UNL SFTP",
    }


@router.get("/{agency_slug}/policies")
def list_policies(
    agency_slug: str,
    agency_id: Optional[str] = Query(None, description="Agency ID override for super_admins"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    classification: list[str] = Query(default_factory=list),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    agent_name: Optional[str] = Query(None),
    ctx: AuthContext = Depends(require_role("admin", "super_admin")),
    db: Session = Depends(get_db),
) -> dict:
    _, agencies = _resolve_scope_agencies(db=db, ctx=ctx, agency_slug=agency_slug, agency_id_override=agency_id)
    agency_ids = [a.id for a in agencies]

    stmt = select(PolicyReport).order_by(desc(PolicyReport.issue_date), desc(PolicyReport.imported_at))
    stmt = _apply_filters(
        stmt,
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=agent_name,
    )
    if classification:
        wanted = [c.strip() for c in classification if c and c.strip()]
        if wanted:
            stmt = stmt.where(PolicyReport.classification.in_(wanted))

    total = int(db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0)
    rows = (
        db.execute(stmt.limit(page_size).offset((page - 1) * page_size)).scalars().all()
    )

    policies = [
        {
            "id": r.id,
            "policy_number": r.policy_number,
            "first_name": r.first_name,
            "last_name": r.last_name,
            "agent_name": r.agent_name,
            "wa_code": r.wa_code,
            "plan_code": r.plan_code,
            "billing_mode": r.billing_mode,
            "issue_date": r.issue_date.isoformat() if r.issue_date else None,
            "paid_to_date": r.paid_to_date.isoformat() if r.paid_to_date else None,
            "app_received_date": r.app_received_date.isoformat() if r.app_received_date else None,
            "annual_premium": float(r.annual_premium or 0.0),
            "issue_state": r.issue_state,
            "classification": r.classification,
            "classification_reason": r.classification_reason,
            "cntrct_code": r.cntrct_code,
            "cntrct_reason": r.cntrct_reason,
        }
        for r in rows
    ]
    return {"policies": policies, "total": total, "page": page, "page_size": page_size}

