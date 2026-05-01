from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import redis

from app.config import settings


JOB_QUEUE_KEY = "gbh:v1:jobs"


@dataclass(frozen=True)
class QueueMessage:
    job_id: str


def get_redis() -> redis.Redis:
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


def enqueue_job(job_id: str) -> None:
    r = get_redis()
    r.rpush(JOB_QUEUE_KEY, job_id)


def dequeue_job(timeout_seconds: int = 15) -> Optional[QueueMessage]:
    r = get_redis()
    item = r.blpop(JOB_QUEUE_KEY, timeout=timeout_seconds)
    if not item:
        return None
    _key, job_id = item
    return QueueMessage(job_id=job_id)

