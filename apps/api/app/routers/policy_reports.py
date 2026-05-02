from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, desc, func, select, text
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
    """Scope logic: admins see only their agency; super_admins see all (when slug=guardian) or one.

    The 'guardian' magic slug means "all active agencies." It does not require an agency row
    with that slug to exist — we fall back to the first active agency as the nominal primary.
    """
    if ctx.role == "admin":
        agency = db.execute(select(Agency).where(Agency.id == ctx.agency_id)).scalar_one_or_none()
        if not agency:
            raise HTTPException(status_code=404, detail="Agency not found")
        return agency, [agency]

    if ctx.role != "super_admin":
        raise HTTPException(status_code=403, detail="Forbidden")

    # "guardian" = all active agencies view; no agency row with slug "guardian" needs to exist
    if agency_slug == "guardian":
        all_active = db.execute(select(Agency).where(Agency.is_active == True)).scalars().all()  # noqa: E712
        if not all_active:
            raise HTTPException(status_code=404, detail="No active agencies found")
        if agency_id_override:
            override = next((a for a in all_active if a.id == agency_id_override), None)
            if not override:
                raise HTTPException(status_code=404, detail="Agency not found")
            return override, [override]
        primary = next((a for a in all_active if a.slug == "guardian"), all_active[0])
        return primary, all_active

    primary = _resolve_agency_for_slug(db, agency_slug)
    if agency_id_override:
        override = db.execute(select(Agency).where(Agency.id == agency_id_override)).scalar_one_or_none()
        if not override:
            raise HTTPException(status_code=404, detail="Agency not found")
        return override, [override]
    return primary, [primary]


def _apply_filters(stmt, *, agency_ids, date_from, date_to, agent_name):
    stmt = stmt.where(PolicyReport.agency_id.in_(agency_ids))
    if date_from:
        stmt = stmt.where(PolicyReport.issue_date.is_not(None), PolicyReport.issue_date >= date_from)
    if date_to:
        stmt = stmt.where(PolicyReport.issue_date.is_not(None), PolicyReport.issue_date <= date_to)
    if agent_name:
        stmt = stmt.where(func.lower(PolicyReport.agent_name).contains(agent_name.lower().strip()))
    return stmt


def _compute_rates(counts: dict, claim_count: int = 0) -> dict:
    """Given a classification-count dict, return computed totals and rates."""
    active     = counts.get("active", 0)
    terminated = counts.get("terminated", 0)
    lapsed     = counts.get("lapsed", 0)
    ne         = counts.get("non_effectuated", 0)
    pc         = counts.get("pending_cancel", 0)
    suspended  = counts.get("suspended", 0)
    pending    = counts.get("pending_new", 0) + counts.get("pending_payment", 0) + counts.get("future_effective", 0)
    total      = sum(counts.values())
    definitive = max(total - pending - suspended, 0)
    cancelled  = terminated + lapsed
    cancelled_excl = max(cancelled - claim_count, 0)
    return {
        "total": total,
        "pending": pending,
        "definitive": definitive,
        "active": active,
        "terminated": terminated,
        "lapsed": lapsed,
        "non_effectuated": ne,
        "pending_cancel": pc,
        "suspended": suspended,
        "cancelled": cancelled,
        "cancelled_excl_claims": cancelled_excl,
        "effectuation_rate":    round(active / definitive * 100.0, 1) if definitive else 0.0,
        "cancel_rate":          round(cancelled_excl / definitive * 100.0, 1) if definitive else 0.0,
        "non_effectuated_rate": round(ne / definitive * 100.0, 1) if definitive else 0.0,
    }


@router.get("/{agency_slug}/available-agents")
def available_agents(
    agency_slug: str,
    agency_id: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    ctx: AuthContext = Depends(require_role("admin", "super_admin")),
    db: Session = Depends(get_db),
) -> dict:
    """Lazy-loaded agent name list for filter dropdowns. Called separately, not on every page load."""
    _, agencies = _resolve_scope_agencies(db=db, ctx=ctx, agency_slug=agency_slug, agency_id_override=agency_id)
    agency_ids = [a.id for a in agencies]
    stmt = _apply_filters(
        select(PolicyReport.agent_name)
        .where(PolicyReport.agent_name != "")
        .distinct()
        .order_by(PolicyReport.agent_name)
        .limit(1000),
        agency_ids=agency_ids,
        date_from=date_from,
        date_to=date_to,
        agent_name=None,
    )
    names = [r[0] for r in db.execute(stmt).all() if r and r[0]]
    return {"agents": names}


@router.get("/{agency_slug}/dashboard-stats")
def dashboard_stats(
    agency_slug: str,
    agency_id: Optional[str] = Query(None, description="Agency ID override for super_admins"),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    agent_name: Optional[str] = Query(None),
    ctx: AuthContext = Depends(require_role("admin", "super_admin")),
    db: Session = Depends(get_db),
) -> dict:
    """
    Fast dashboard stats: buckets, rates, trend, states, agencies, agents.
    Expensive extras (product mix, underwriting, cancellation analysis) are in /dashboard-extras.
    """
    primary, agencies = _resolve_scope_agencies(
        db=db, ctx=ctx, agency_slug=agency_slug, agency_id_override=agency_id
    )
    agency_ids = [a.id for a in agencies]

    # ── Buckets (counts + premium per classification) ──────────────────────────
    buckets_stmt = _apply_filters(
        select(
            PolicyReport.classification,
            func.count().label("count"),
            func.coalesce(func.sum(PolicyReport.annual_premium), 0.0).label("annual_premium"),
        ).group_by(PolicyReport.classification),
        agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
    )
    bucket_rows = db.execute(buckets_stmt).all()

    total_policies = int(sum(int(r.count) for r in bucket_rows))
    total_premium = float(sum(float(r.annual_premium or 0.0) for r in bucket_rows))

    buckets: dict[str, dict] = {}
    for r in bucket_rows:
        key = (r.classification or "unknown").strip() or "unknown"
        count = int(r.count or 0)
        pct = round((count / total_policies * 100.0), 1) if total_policies else 0.0
        buckets[key] = {
            "count": count,
            "annual_premium": float(r.annual_premium or 0.0),
            "label": CLASSIFICATION_LABELS.get(key, key),
            "pct": pct,
        }

    def bcount(key: str) -> int:
        return int(buckets.get(key, {}).get("count", 0))

    def bprem(key: str) -> float:
        return float(buckets.get(key, {}).get("annual_premium", 0.0))

    active_count        = bcount("active")
    active_premium      = bprem("active")
    avg_premium         = round(active_premium / active_count, 2) if active_count else 0.0
    terminated_count    = bcount("terminated")
    lapsed_count        = bcount("lapsed")
    cancelled_count     = terminated_count + lapsed_count
    non_effectuated_count = bcount("non_effectuated")
    suspended_count     = bcount("suspended")
    pending_new_count   = bcount("pending_new")
    pending_payment_count = bcount("pending_payment")
    pending_cancel_count  = bcount("pending_cancel")
    future_effective_count = bcount("future_effective")
    pending_pipeline    = pending_new_count + pending_payment_count + future_effective_count
    definitive          = max(total_policies - pending_pipeline - suspended_count, 0)

    # ── Claim cancellations (DC reason) per agency ────────────────────────────
    claim_by_agency_stmt = _apply_filters(
        select(PolicyReport.agency_id, func.count().label("count"))
        .where(
            PolicyReport.classification.in_(["terminated", "lapsed"]),
            func.upper(func.coalesce(PolicyReport.cntrct_reason, "")) == "DC",
        )
        .group_by(PolicyReport.agency_id),
        agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
    )
    claim_by_agency: dict[str, int] = {
        r.agency_id: int(r.count or 0) for r in db.execute(claim_by_agency_stmt).all()
    }

    # ── Claim cancellations per agent (for agent breakdown) ───────────────────
    claim_by_agent_stmt = _apply_filters(
        select(
            PolicyReport.agency_id,
            PolicyReport.agent_name,
            PolicyReport.wa_code,
            func.count().label("count"),
        )
        .where(
            PolicyReport.agent_name != "",
            PolicyReport.classification.in_(["terminated", "lapsed"]),
            func.upper(func.coalesce(PolicyReport.cntrct_reason, "")) == "DC",
        )
        .group_by(PolicyReport.agency_id, PolicyReport.agent_name, PolicyReport.wa_code),
        agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
    )
    claim_by_agent: dict[tuple[str, str, str], int] = {
        (r.agency_id, r.agent_name or "", r.wa_code or ""): int(r.count or 0)
        for r in db.execute(claim_by_agent_stmt).all()
    }

    claim_count = int(sum(claim_by_agency.values()))
    cancelled_excl_claims_count = max(cancelled_count - claim_count, 0)
    effectuation_rate    = round(active_count / definitive * 100.0, 1) if definitive else 0.0
    cancel_rate          = round(cancelled_excl_claims_count / definitive * 100.0, 1) if definitive else 0.0
    non_effectuated_rate = round(non_effectuated_count / definitive * 100.0, 1) if definitive else 0.0

    # ── State distribution (active policies) ──────────────────────────────────
    states_stmt = _apply_filters(
        select(
            func.upper(func.coalesce(PolicyReport.issue_state, "")).label("state"),
            func.count().label("count"),
        )
        .where(
            func.coalesce(PolicyReport.issue_state, "") != "",
            PolicyReport.classification == "active",
        )
        .group_by("state")
        .order_by(desc("count")),
        agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
    )
    states: dict[str, int] = {r.state: int(r.count) for r in db.execute(states_stmt).all() if r.state}

    # ── Monthly trend (issue_date truncated to month) ──────────────────────────
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
        agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
    )
    month_map: dict[str, dict[str, int]] = {}
    for r in db.execute(monthly_stmt).all():
        m = r.month
        if not m:
            continue
        cls = (r.classification or "unknown").strip() or "unknown"
        month_map.setdefault(m, {})
        month_map[m][cls] = month_map[m].get(cls, 0) + int(r.count or 0)

    def _month_label(m: str) -> str:
        try:
            y, mm = m.split("-")
            return date(int(y), int(mm), 1).strftime("%b %Y")
        except Exception:
            return m

    monthly_trend = [
        {
            "month": m,
            "month_full": _month_label(m),
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
        for m, cls_counts in sorted(month_map.items())
    ]

    # ── Reinstatement ──────────────────────────────────────────────────────────
    reinstated_count = int(
        db.execute(
            _apply_filters(
                select(func.count())
                .where(func.upper(func.coalesce(PolicyReport.cntrct_reason, "")).in_(["RS", "RE"])),
                agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
            )
        ).scalar() or 0
    )
    reinstatable_pool = terminated_count + lapsed_count + non_effectuated_count + pending_cancel_count
    ever_cancelled_pool = reinstated_count + reinstatable_pool
    reinstatement = {
        "count": reinstated_count,
        "pool": ever_cancelled_pool,
        "rate": round(reinstated_count / ever_cancelled_pool * 100.0, 1) if ever_cancelled_pool else 0.0,
    }

    # ── Agency breakdown ───────────────────────────────────────────────────────
    agency_bucket_rows = db.execute(
        _apply_filters(
            select(
                PolicyReport.agency_id,
                PolicyReport.classification,
                func.count().label("count"),
                func.coalesce(func.sum(PolicyReport.annual_premium), 0.0).label("annual_premium"),
            ).group_by(PolicyReport.agency_id, PolicyReport.classification),
            agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
        )
    ).all()
    agency_meta = {a.id: a for a in agencies}
    agency_map: dict[str, dict] = {}
    for r in agency_bucket_rows:
        a_id = r.agency_id
        cls = (r.classification or "unknown").strip() or "unknown"
        agency_map.setdefault(a_id, {
            "id": a_id,
            "code": (agency_meta.get(a_id).unl_prefix or "").strip() if agency_meta.get(a_id) else "",
            "name": agency_meta.get(a_id).name if agency_meta.get(a_id) else a_id,
            "slug": agency_meta.get(a_id).slug if agency_meta.get(a_id) else "",
            "counts": {},
            "active_premium": 0.0,
        })
        count = int(r.count or 0)
        agency_map[a_id]["counts"][cls] = agency_map[a_id]["counts"].get(cls, 0) + count
        if cls == "active":
            agency_map[a_id]["active_premium"] += float(r.annual_premium or 0.0)

    agencies_out = []
    for a_id, payload in agency_map.items():
        c = payload["counts"]
        s = _compute_rates(c, claim_count=int(claim_by_agency.get(a_id, 0)))
        agencies_out.append({
            "id": a_id,
            "code": payload["code"] or payload["slug"] or a_id[:6],
            "name": payload["name"],
            "slug": payload["slug"],
            **{k: s[k] for k in ("total", "active", "pending", "terminated", "non_effectuated",
                                  "pending_cancel", "lapsed", "suspended",
                                  "effectuation_rate", "cancel_rate", "non_effectuated_rate")},
            "pending_new": c.get("pending_new", 0),
            "pending_payment": c.get("pending_payment", 0),
            "future_effective": c.get("future_effective", 0),
            "active_premium": round(float(payload["active_premium"]), 2),
        })
    agencies_out.sort(key=lambda a: a.get("active_premium", 0.0), reverse=True)

    # ── Agent breakdown ────────────────────────────────────────────────────────
    agent_rows = db.execute(
        _apply_filters(
            select(
                PolicyReport.agent_name,
                PolicyReport.wa_code,
                PolicyReport.agency_id,
                PolicyReport.classification,
                func.count().label("count"),
                func.coalesce(func.sum(PolicyReport.annual_premium), 0.0).label("annual_premium"),
            )
            .where(PolicyReport.agent_name != "")
            .group_by(PolicyReport.agent_name, PolicyReport.wa_code, PolicyReport.agency_id, PolicyReport.classification),
            agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
        )
    ).all()
    agent_map: dict[tuple[str, str, str], dict] = {}
    for r in agent_rows:
        key = (r.agent_name or "", r.wa_code or "", r.agency_id or "")
        agent_map.setdefault(key, {
            "agent_name": r.agent_name or "",
            "wa_code": r.wa_code or "",
            "agency_id": r.agency_id or "",
            "agency_code": (agency_meta.get(r.agency_id).unl_prefix or "").strip() if agency_meta.get(r.agency_id) else "",
            "agency_name": agency_meta.get(r.agency_id).name if agency_meta.get(r.agency_id) else "",
            "counts": {},
            "active_premium": 0.0,
        })
        cls = (r.classification or "unknown").strip() or "unknown"
        agent_map[key]["counts"][cls] = agent_map[key]["counts"].get(cls, 0) + int(r.count or 0)
        if cls == "active":
            agent_map[key]["active_premium"] += float(r.annual_premium or 0.0)

    agents_out = []
    for payload in agent_map.values():
        c = payload["counts"]
        claim_key = (payload["agency_id"], payload["agent_name"], payload["wa_code"])
        s = _compute_rates(c, claim_count=int(claim_by_agent.get(claim_key, 0)))
        agents_out.append({
            "agent_name": payload["agent_name"],
            "wa_code": payload["wa_code"],
            "agency_code": payload["agency_code"],
            "agency_name": payload["agency_name"],
            **{k: s[k] for k in ("total", "active", "pending", "terminated", "non_effectuated",
                                  "pending_cancel", "lapsed", "suspended",
                                  "effectuation_rate", "cancel_rate", "non_effectuated_rate")},
            "active_premium": round(float(payload["active_premium"]), 2),
        })
    agents_out.sort(key=lambda a: a.get("active_premium", 0.0), reverse=True)

    # ── Last import metadata ───────────────────────────────────────────────────
    last = db.execute(
        select(PolicyReport.source_file, PolicyReport.imported_at)
        .where(PolicyReport.agency_id.in_(agency_ids))
        .order_by(desc(PolicyReport.imported_at))
        .limit(1)
    ).first()

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
        "filters_active": bool(date_from or date_to or (agent_name and agent_name.strip())),
        "buckets": buckets,
        "agencies": agencies_out,
        "agents": agents_out,
        "monthly_trend": monthly_trend,
        "states": states,
        "reinstatement": reinstatement,
        "last_import_file": last[0] if last else None,
        "last_import_at": last[1].isoformat() if last and last[1] else None,
        "report_date": date.today().isoformat(),
        "source": "UNL SFTP",
    }


@router.get("/{agency_slug}/dashboard-extras")
def dashboard_extras(
    agency_slug: str,
    agency_id: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    agent_name: Optional[str] = Query(None),
    ctx: AuthContext = Depends(require_role("admin", "super_admin")),
    db: Session = Depends(get_db),
) -> dict:
    """
    Slower analytics loaded after the main dashboard renders:
    product mix, underwriting speed, reason breakdown, cancellation deep-dive.
    """
    _, agencies = _resolve_scope_agencies(
        db=db, ctx=ctx, agency_slug=agency_slug, agency_id_override=agency_id
    )
    agency_ids = [a.id for a in agencies]

    # ── Reason breakdown ───────────────────────────────────────────────────────
    raw_reason_rows = db.execute(
        _apply_filters(
            select(
                func.upper(func.coalesce(PolicyReport.cntrct_reason, "")).label("code"),
                func.count().label("count"),
            )
            .where(func.coalesce(PolicyReport.cntrct_reason, "") != "")
            .group_by("code")
            .order_by(desc("count")),
            agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
        )
    ).all()
    reason_counts: dict[str, int] = {}
    for r in raw_reason_rows:
        code = (r.code or "").strip().upper()
        if not code:
            continue
        canonical = REASON_CANONICAL.get(code, code)
        reason_counts[canonical] = reason_counts.get(canonical, 0) + int(r.count or 0)
    reason_breakdown = sorted(
        [{"code": c, "label": CONTRACT_REASON_LABELS.get(c, c), "count": n} for c, n in reason_counts.items()],
        key=lambda x: -x["count"],
    )

    # ── Product mix ────────────────────────────────────────────────────────────
    product_rows = db.execute(
        _apply_filters(
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
            ).group_by("plan_code", "classification"),
            agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
        )
    ).all()
    product_map: dict[str, dict] = {}
    for r in product_rows:
        code = (r.plan_code or "UNKNOWN").strip().upper() or "UNKNOWN"
        product_map.setdefault(code, {
            "plan_code": code, "plan_name": plan_label(code), "total": 0, "active": 0,
            "pending_new": 0, "pending_payment": 0, "pending_cancel": 0, "future_effective": 0,
            "terminated": 0, "non_effectuated": 0, "lapsed": 0, "suspended": 0,
            "active_premium": 0.0, "claim_count": 0,
        })
        cls = (r.classification or "unknown").strip() or "unknown"
        count = int(r.count or 0)
        product_map[code]["total"] += count
        if cls in product_map[code]:
            product_map[code][cls] += count
        if cls == "active":
            product_map[code]["active_premium"] += float(r.annual_premium or 0.0)
        product_map[code]["claim_count"] += int(r.claim_count or 0)
    product_mix = []
    for s in product_map.values():
        pending = s["pending_new"] + s["pending_payment"] + s["future_effective"]
        def_p = int(s["total"]) - pending - int(s["suspended"])
        cancelled_p = int(s["terminated"]) + int(s["lapsed"])
        cancelled_excl = max(cancelled_p - int(s["claim_count"]), 0)
        ne_p = int(s["non_effectuated"]) + int(s["pending_cancel"])
        product_mix.append({
            **s,
            "active_premium": round(float(s["active_premium"]), 2),
            "effectuation_rate": round(s["active"] / def_p * 100.0, 1) if def_p else 0.0,
            "cancel_rate": round(cancelled_excl / def_p * 100.0, 1) if def_p else 0.0,
            "non_effectuated_rate": round(ne_p / def_p * 100.0, 1) if def_p else 0.0,
        })
    product_mix.sort(key=lambda x: -int(x.get("total", 0)))

    # ── Underwriting speed — single query for count + avg ─────────────────────
    uw_days = (PolicyReport.issue_date - PolicyReport.app_received_date).label("days")
    uw_agg = db.execute(
        _apply_filters(
            select(func.count().label("n"), func.avg(uw_days).label("avg"))
            .where(
                PolicyReport.issue_date.is_not(None),
                PolicyReport.app_received_date.is_not(None),
                PolicyReport.issue_date >= PolicyReport.app_received_date,
            ),
            agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
        )
    ).first()
    uw_count = int(uw_agg.n or 0) if uw_agg else 0
    uw_avg   = round(float(uw_agg.avg or 0.0), 1) if uw_agg else 0.0

    uw_dist_rows = db.execute(
        _apply_filters(
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
            agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
        )
    ).all()
    uw_distribution = {r.bucket: int(r.count or 0) for r in uw_dist_rows if r.bucket}

    underwriting_speed = {
        "avg_days": uw_avg,
        "sample_size": uw_count,
        "distribution": uw_distribution,
    }

    # ── Cancellation aggregate (no detail rows — expensive) ───────────────────
    off_books = ["terminated", "lapsed", "non_effectuated", "pending_cancel"]
    days_on_books = func.coalesce(PolicyReport.paid_to_date - PolicyReport.issue_date, 0)
    cancel_agg = db.execute(
        _apply_filters(
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
            agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name,
        )
    ).first()

    cancellation = {
        "never_started": int(cancel_agg.never_started or 0) if cancel_agg else 0,
        "paid_then_cancelled": int(cancel_agg.paid_then_cancelled or 0) if cancel_agg else 0,
        "avg_days_on_books": round(float(cancel_agg.avg_days or 0.0), 1) if cancel_agg else 0.0,
        "days_buckets": {
            "0 days (Never Started)": int(cancel_agg.never_started or 0) if cancel_agg else 0,
            "1-30 days": int(cancel_agg.b_1_30 or 0) if cancel_agg else 0,
            "31-60 days": int(cancel_agg.b_31_60 or 0) if cancel_agg else 0,
            "61-90 days": int(cancel_agg.b_61_90 or 0) if cancel_agg else 0,
            "91+ days": int(cancel_agg.b_91p or 0) if cancel_agg else 0,
        },
    }

    return {
        "reason_breakdown": reason_breakdown,
        "product_mix": product_mix,
        "underwriting_speed": underwriting_speed,
        "cancellation": cancellation,
    }


@router.get("/{agency_slug}/policies")
def list_policies(
    agency_slug: str,
    agency_id: Optional[str] = Query(None),
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
    stmt = _apply_filters(stmt, agency_ids=agency_ids, date_from=date_from, date_to=date_to, agent_name=agent_name)
    if classification:
        wanted = [c.strip() for c in classification if c and c.strip()]
        if wanted:
            stmt = stmt.where(PolicyReport.classification.in_(wanted))

    total = int(db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0)
    rows = db.execute(stmt.limit(page_size).offset((page - 1) * page_size)).scalars().all()

    return {
        "policies": [
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
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }
