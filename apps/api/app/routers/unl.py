from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import AuthContext, forbid_impersonated_writes, require_role
from app.db import get_db
from app.models import Agency, PolicyReport, UnroutedPolicyRow
from app.jobs import create_job
from app.queue import enqueue_job
from app.unl_sftp import list_policy_files
from app.policy_classifier import classify_policy, parse_date


router = APIRouter(prefix="/api/unl", tags=["unl"])


@router.get("/status")
def status(
    _ctx: AuthContext = Depends(require_role("super_admin", "admin")),
    db: Session = Depends(get_db),
):
    db_error = None
    try:
        files = list_policy_files()
    except Exception as exc:
        files = []
        sftp_error = str(exc)
    else:
        sftp_error = None

    # Postgres requires GROUP BY when mixing aggregates/non-aggregates; grab latest row instead.
    try:
        last_import = (
            db.execute(
                select(PolicyReport.source_file, PolicyReport.imported_at)
                .order_by(PolicyReport.imported_at.desc())
                .limit(1)
            ).first()
            or None
        )
    except Exception as exc:
        last_import = None
        db_error = str(exc)

    try:
        unrouted = db.execute(select(func.count(UnroutedPolicyRow.id))).scalar() or 0
    except Exception as exc:
        unrouted = 0
        db_error = f"{db_error} | {exc}" if db_error else str(exc)

    return {
        "sftp_files": files[:20],
        "sftp_error": sftp_error,
        "db_error": db_error,
        "last_import_file": last_import[0] if last_import else None,
        "last_import_at": last_import[1].isoformat() if last_import and last_import[1] else None,
        "unrouted_rows_total": int(unrouted),
    }


@router.get("/unrouted")
def list_unrouted(
    limit: int = 25,
    _ctx: AuthContext = Depends(require_role("super_admin", "admin")),
    db: Session = Depends(get_db),
):
    limit = max(1, min(int(limit or 25), 200))

    counts = dict(
        db.execute(
            select(UnroutedPolicyRow.extracted_prefix, func.count(UnroutedPolicyRow.id))
            .group_by(UnroutedPolicyRow.extracted_prefix)
            .order_by(func.count(UnroutedPolicyRow.id).desc())
        ).all()
    )

    rows = (
        db.execute(select(UnroutedPolicyRow).order_by(UnroutedPolicyRow.imported_at.desc()).limit(limit))
        .scalars()
        .all()
    )

    out_rows: list[dict] = []
    for r in rows:
        try:
            data = json.loads(r.row_json or "{}")
        except Exception:
            data = {}
        out_rows.append(
            {
                "id": r.id,
                "source_file": r.source_file,
                "wa_code": r.wa_code,
                "extracted_prefix": r.extracted_prefix,
                "policy_number": str(data.get("policy_number") or ""),
                "agent_name": str(data.get("agent_name") or ""),
            }
        )

    return {"counts": counts, "rows": out_rows}


@router.post("/reroute-unrouted")
def reroute_unrouted(
    limit: int = 2000,
    ctx: AuthContext = Depends(require_role("super_admin")),
    db: Session = Depends(get_db),
):
    forbid_impersonated_writes(ctx)
    limit = max(1, min(int(limit or 2000), 20000))

    agencies = db.execute(select(Agency).where(Agency.is_active == True)).scalars().all()  # noqa: E712
    prefix_map = {a.unl_prefix.upper(): a for a in agencies if a.unl_prefix}

    rows = db.execute(select(UnroutedPolicyRow).limit(limit)).scalars().all()

    processed = 0
    routed = 0
    still_unrouted = 0
    created = 0
    updated = 0

    for r in rows:
        processed += 1
        agency = prefix_map.get((r.extracted_prefix or "").upper())
        if not agency:
            still_unrouted += 1
            continue

        try:
            row = json.loads(r.row_json or "{}")
        except Exception:
            row = {}

        policy_number = str(row.get("policy_number") or "").strip()
        if not policy_number:
            still_unrouted += 1
            continue

        wa_code = str(row.get("wa_code") or r.wa_code or "").strip()

        issue_dt = parse_date(row.get("issue_date_raw"))
        paid_to_dt = parse_date(row.get("paid_to_date_raw"))
        app_dt = parse_date(row.get("app_received_date_raw"))

        classification, reason = classify_policy(
            {
                **row,
                "issue_date": issue_dt,
                "paid_to_date": paid_to_dt,
            }
        )

        prem_raw = row.get("annual_premium", "0")
        try:
            annual_premium = float(str(prem_raw).replace(",", "").replace("$", "").strip() or "0")
        except ValueError:
            annual_premium = 0.0

        existing = db.execute(
            select(PolicyReport).where(
                PolicyReport.agency_id == agency.id,
                PolicyReport.policy_number == policy_number,
            )
        ).scalar_one_or_none()

        if existing:
            existing.source_file = r.source_file
            existing.imported_at = r.imported_at
            existing.ga_code = str(row.get("ga_code") or "")
            existing.wa_code = wa_code
            existing.agent_name = str(row.get("agent_name") or "")
            existing.plan_code = str(row.get("plan_code") or "")
            existing.cntrct_code = str(row.get("cntrct_code") or "")
            existing.cntrct_reason = str(row.get("cntrct_reason") or "")
            existing.billing_mode = str(row.get("billing_mode") or "")
            existing.issue_date_raw = str(row.get("issue_date_raw") or "")
            existing.paid_to_date_raw = str(row.get("paid_to_date_raw") or "")
            existing.app_received_date_raw = str(row.get("app_received_date_raw") or "")
            existing.issue_date = issue_dt
            existing.paid_to_date = paid_to_dt
            existing.app_received_date = app_dt
            existing.annual_premium = annual_premium
            existing.issue_state = str(row.get("issue_state") or "")
            existing.first_name = str(row.get("first_name") or "")
            existing.last_name = str(row.get("last_name") or "")
            existing.zip_code = str(row.get("zip_code") or "")
            existing.phone = str(row.get("phone") or "")
            existing.classification = classification
            existing.classification_reason = reason
            updated += 1
        else:
            db.add(
                PolicyReport(
                    agency_id=agency.id,
                    source_file=r.source_file,
                    imported_at=r.imported_at,
                    policy_number=policy_number,
                    wa_code=wa_code,
                    agent_name=str(row.get("agent_name") or ""),
                    ga_code=str(row.get("ga_code") or ""),
                    plan_code=str(row.get("plan_code") or ""),
                    cntrct_code=str(row.get("cntrct_code") or ""),
                    cntrct_reason=str(row.get("cntrct_reason") or ""),
                    billing_mode=str(row.get("billing_mode") or ""),
                    issue_date_raw=str(row.get("issue_date_raw") or ""),
                    paid_to_date_raw=str(row.get("paid_to_date_raw") or ""),
                    app_received_date_raw=str(row.get("app_received_date_raw") or ""),
                    issue_date=issue_dt,
                    paid_to_date=paid_to_dt,
                    app_received_date=app_dt,
                    annual_premium=annual_premium,
                    issue_state=str(row.get("issue_state") or ""),
                    first_name=str(row.get("first_name") or ""),
                    last_name=str(row.get("last_name") or ""),
                    zip_code=str(row.get("zip_code") or ""),
                    phone=str(row.get("phone") or ""),
                    classification=classification,
                    classification_reason=reason,
                )
            )
            created += 1

        db.delete(r)
        routed += 1

    db.commit()
    return {
        "processed": processed,
        "routed": routed,
        "still_unrouted": still_unrouted,
        "created": created,
        "updated": updated,
    }


@router.post("/import-latest")
def import_latest(
    _ctx: AuthContext = Depends(require_role("super_admin")),
    db: Session = Depends(get_db),
):
    try:
        job = create_job(
            db,
            job_type="unl_import_latest",
            agency_id=_ctx.agency_id,
            created_by_user_id=_ctx.user_id,
            params={},
        )
        enqueue_job(job.id)
        return {"queued": True, "job_id": job.id}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

