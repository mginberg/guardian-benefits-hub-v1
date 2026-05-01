import logging
import time

from apscheduler.schedulers.background import BackgroundScheduler

from app.config import settings
from app.db import SessionLocal
from app.db_init import init_db
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


def main() -> None:
    init_db()

    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(_tick, "interval", minutes=10, id="tick")

    # UNL SFTP ingest (daily). Safe to run even if credentials not set (will log error).
    scheduler.add_job(_unl_import_latest, "cron", hour=11, minute=0, id="unl_import_latest")
    scheduler.start()

    logger.info("worker started")
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        logger.info("worker stopping")
        scheduler.shutdown()


if __name__ == "__main__":
    main()

