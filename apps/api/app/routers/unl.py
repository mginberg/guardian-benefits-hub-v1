from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import AuthContext, require_role
from app.db import get_db
from app.models import PolicyReport, UnroutedPolicyRow
from app.unl_sftp import import_latest_policy_file, list_policy_files


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

    last_import = db.execute(
        select(PolicyReport.source_file, func.max(PolicyReport.imported_at))
    ).first()

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
        return import_latest_policy_file(db)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

