import asyncio
import logging
import time
import uuid

from apscheduler.schedulers.background import BackgroundScheduler

from app.config import settings
from app.db import SessionLocal
from app.db_init import init_db
from app.ghl_sync import sync_all_agencies
from app.jobs import get_job, mark_job_failed, mark_job_running, mark_job_succeeded, parse_job_params
from app.models import JobStatus
from app.queue import dequeue_job
from app.unl_sftp import import_latest_policy_file


logger = logging.getLogger("worker")
logging.basicConfig(level=logging.INFO)


def _tick():
    logger.info("worker tick (env=%s)", settings.env)


def _unl_import_latest():
    db = SessionLocal()
    try:
        result = import_latest_policy_file(db)
        logger.info("UNL import result: %s", result)
    except Exception as exc:
        logger.exception("UNL import failed: %s", exc)
    finally:
        db.close()


def _ghl_sync_all():
    """Sync GHL contacts for all agencies — runs every 30 min."""
    db = SessionLocal()
    try:
        result = asyncio.run(sync_all_agencies(db))
        logger.info("GHL sync result: %s", result)
    except Exception as exc:
        logger.exception("GHL sync failed: %s", exc)
    finally:
        db.close()


def _process_job(job_id: str) -> None:
    db = SessionLocal()
    lock_token = str(uuid.uuid4())
    try:
        job = get_job(db, job_id)
        if not job:
            logger.warning("job not found: %s", job_id)
            return
        if job.status != JobStatus.queued:
            return

        mark_job_running(db, job, lock_token)
        params = parse_job_params(job)

        if job.job_type == "unl_import_latest":
            result = import_latest_policy_file(db)
            mark_job_succeeded(db, job, result=result)
            return

        mark_job_failed(db, job, error=f"Unknown job_type: {job.job_type}")
    except Exception as exc:
        try:
            job = get_job(db, job_id)
            if job and job.status == JobStatus.running and job.lock_token == lock_token:
                mark_job_failed(db, job, error=str(exc))
        except Exception:
            logger.exception("failed to mark job failed")
        logger.exception("job failed: %s", exc)
    finally:
        db.close()


def _job_loop() -> None:
    while True:
        msg = dequeue_job(timeout_seconds=15)
        if not msg:
            continue
        _process_job(msg.job_id)


def main() -> None:
    init_db()

    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(_tick, "interval", minutes=10, id="tick")

    # UNL SFTP ingest (daily). Safe to run even if credentials not set (will log error).
    scheduler.add_job(
        _unl_import_latest,
        "cron",
        hour=settings.unl_import_cron_hour,
        minute=settings.unl_import_cron_minute,
        id="unl_import_latest",
    )

    # GHL leaderboard sync (every 30 min). Skips agencies without GHL credentials.
    scheduler.add_job(
        _ghl_sync_all,
        "interval",
        minutes=settings.ghl_sync_interval_minutes,
        id="ghl_sync_all",
    )
    scheduler.start()

    logger.info("worker started")
    try:
        _job_loop()
    except KeyboardInterrupt:
        logger.info("worker stopping")
        scheduler.shutdown()


if __name__ == "__main__":
    main()

