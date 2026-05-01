#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-8000}"

# In V1 we keep startup deterministic: create tables if missing, then start API.
python -m app.db_init

exec python -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT"

