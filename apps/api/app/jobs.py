from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import orjson
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ids import new_id
from app.models import Job, JobStatus


def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_job(
    db: Session,
    *,
    job_type: str,
    agency_id: str,
    created_by_user_id: str,
    params: dict[str, Any],
) -> Job:
    job = Job(
        id=new_id(),
        job_type=job_type,
        agency_id=agency_id,
        created_by_user_id=created_by_user_id,
        status=JobStatus.queued,
        params_json=orjson.dumps(params).decode("utf-8"),
        result_json="{}",
        error="",
        queued_at=_now(),
    )
    db.add(job)
    db.commit()
    return job


def get_job(db: Session, job_id: str) -> Job | None:
    return db.execute(select(Job).where(Job.id == job_id)).scalar_one_or_none()


def mark_job_running(db: Session, job: Job, lock_token: str) -> None:
    job.status = JobStatus.running
    job.started_at = _now()
    job.locked_at = _now()
    job.lock_token = lock_token
    db.commit()


def mark_job_succeeded(db: Session, job: Job, *, result: dict[str, Any]) -> None:
    job.status = JobStatus.succeeded
    job.finished_at = _now()
    job.result_json = orjson.dumps(result).decode("utf-8")
    job.error = ""
    db.commit()


def mark_job_failed(db: Session, job: Job, *, error: str) -> None:
    job.status = JobStatus.failed
    job.finished_at = _now()
    job.error = error[:10000]
    db.commit()


def parse_job_params(job: Job) -> dict[str, Any]:
    try:
        return json.loads(job.params_json or "{}")
    except Exception:
        return {}

