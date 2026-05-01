from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import AuthContext, require_role
from app.db import get_db
from app.jobs import create_job, get_job
from app.models import Job
from app.queue import enqueue_job


router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.post("/unl-import-latest")
def queue_unl_import_latest(
    ctx: AuthContext = Depends(require_role("super_admin")),
    db: Session = Depends(get_db),
):
    job = create_job(
        db,
        job_type="unl_import_latest",
        agency_id=ctx.agency_id,
        created_by_user_id=ctx.user_id,
        params={},
    )
    enqueue_job(job.id)
    return {"job_id": job.id}


@router.get("/{job_id}")
def get_job_status(
    job_id: str,
    ctx: AuthContext = Depends(require_role("super_admin", "admin")),
    db: Session = Depends(get_db),
):
    job = get_job(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if ctx.role != "super_admin" and job.agency_id != ctx.agency_id:
        raise HTTPException(status_code=403, detail="Forbidden")
    try:
        params = json.loads(job.params_json or "{}")
    except Exception:
        params = {}
    try:
        result = json.loads(job.result_json or "{}")
    except Exception:
        result = {}
    return {
        "id": job.id,
        "job_type": job.job_type,
        "status": job.status.value,
        "error": job.error,
        "params": params,
        "result": result,
        "queued_at": job.queued_at.isoformat() if job.queued_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


@router.get("")
def list_jobs(
    limit: int = 50,
    ctx: AuthContext = Depends(require_role("super_admin", "admin")),
    db: Session = Depends(get_db),
):
    q = select(Job).order_by(Job.queued_at.desc()).limit(min(limit, 200))
    if ctx.role != "super_admin":
        q = q.where(Job.agency_id == ctx.agency_id)
    jobs = db.execute(q).scalars().all()
    return {
        "jobs": [
            {
                "id": j.id,
                "job_type": j.job_type,
                "status": j.status.value,
                "queued_at": j.queued_at.isoformat() if j.queued_at else None,
                "finished_at": j.finished_at.isoformat() if j.finished_at else None,
                "error": j.error,
            }
            for j in jobs
        ]
    }

