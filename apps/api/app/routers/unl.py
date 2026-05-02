from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import AuthContext, forbid_impersonated_writes, require_role
from app.db import get_db
from app.jobs import create_job
from app.models import Agency, PolicyReport, UnroutedPolicyRow
from app.queue import enqueue_job
from app.unl_sftp import list_policy_files, upsert_policy_row


router = APIRouter(prefix="/api/unl", tags=["unl"])


@router.get("/status")
def status(
    _ctx: AuthContext = Depends(require_role("super_admin", "admin")),
    db: Session = Depends(get_db),
):
    db_error = None
    try:
        files = list_policy_files()
        sftp_error = None
    except Exception as exc:
        files = []
        sftp_error = str(exc)

    try:
        last_import = db.execute(
            select(PolicyReport.source_file, PolicyReport.imported_at)
            .order_by(PolicyReport.imported_at.desc())
            .limit(1)
        ).first()
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
    limit = max(1, min(limit, 200))
    counts = dict(
        db.execute(
            select(UnroutedPolicyRow.extracted_prefix, func.count(UnroutedPolicyRow.id))
            .group_by(UnroutedPolicyRow.extracted_prefix)
            .order_by(func.count(UnroutedPolicyRow.id).desc())
        ).all()
    )
    rows = db.execute(
        select(UnroutedPolicyRow).order_by(UnroutedPolicyRow.imported_at.desc()).limit(limit)
    ).scalars().all()

    out_rows = []
    for r in rows:
        try:
            data = json.loads(r.row_json or "{}")
        except Exception:
            data = {}
        out_rows.append({
            "id": r.id,
            "source_file": r.source_file,
            "wa_code": r.wa_code,
            "extracted_prefix": r.extracted_prefix,
            "policy_number": str(data.get("policy_number") or ""),
            "agent_name": str(data.get("agent_name") or ""),
        })

    return {"counts": counts, "rows": out_rows}


@router.post("/reroute-unrouted")
def reroute_unrouted(
    limit: int = 2000,
    ctx: AuthContext = Depends(require_role("super_admin")),
    db: Session = Depends(get_db),
):
    forbid_impersonated_writes(ctx)
    limit = max(1, min(limit, 20000))

    agencies = db.execute(select(Agency).where(Agency.is_active == True)).scalars().all()  # noqa: E712
    prefix_map = {a.unl_prefix.upper(): a for a in agencies if a.unl_prefix}

    pending = db.execute(select(UnroutedPolicyRow).limit(limit)).scalars().all()

    routed = created = updated = still_unrouted = 0
    for r in pending:
        agency = prefix_map.get((r.extracted_prefix or "").upper())
        if not agency:
            still_unrouted += 1
            continue

        try:
            row = json.loads(r.row_json or "{}")
        except Exception:
            still_unrouted += 1
            continue

        if not row.get("policy_number"):
            still_unrouted += 1
            continue

        was_created, _ = upsert_policy_row(
            db,
            agency_id=agency.id,
            row=row,
            source_file=r.source_file,
            imported_at=r.imported_at,
        )
        if was_created:
            created += 1
        else:
            updated += 1
        db.delete(r)
        routed += 1

    db.commit()
    return {"processed": len(pending), "routed": routed, "still_unrouted": still_unrouted, "created": created, "updated": updated}


@router.post("/import-latest")
def import_latest(
    ctx: AuthContext = Depends(require_role("super_admin")),
    db: Session = Depends(get_db),
):
    try:
        job = create_job(
            db,
            job_type="unl_import_latest",
            agency_id=ctx.agency_id,
            created_by_user_id=ctx.user_id,
            params={},
        )
        enqueue_job(job.id)
        return {"queued": True, "job_id": job.id}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

