from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import AuthContext, require_role
from app.db import get_db
from app.models import PolicyReport, UnroutedPolicyRow
from app.jobs import create_job
from app.queue import enqueue_job
from app.unl_sftp import list_policy_files


router = APIRouter(prefix="/api/unl", tags=["unl"])


@router.get("/status")
def status(
    _ctx: AuthContext = Depends(require_role("super_admin", "admin")),
    db: Session = Depends(get_db),
):
    try:
        files = list_policy_files()
    except Exception as exc:
        files = []
        sftp_error = str(exc)
    else:
        sftp_error = None

    # Postgres requires GROUP BY when mixing aggregates/non-aggregates; grab latest row instead.
    last_import = (
        db.execute(
            select(PolicyReport.source_file, PolicyReport.imported_at)
            .order_by(PolicyReport.imported_at.desc())
            .limit(1)
        ).first()
        or None
    )

    unrouted = db.execute(select(func.count(UnroutedPolicyRow.id))).scalar() or 0

    return {
        "sftp_files": files[:20],
        "sftp_error": sftp_error,
        "last_import_file": last_import[0] if last_import else None,
        "last_import_at": last_import[1].isoformat() if last_import and last_import[1] else None,
        "unrouted_rows_total": int(unrouted),
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

