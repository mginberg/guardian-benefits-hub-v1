FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
    && rm -rf /var/lib/apt/lists/*

COPY apps/api/pyproject.toml apps/api/requirements.txt /app/

RUN python -m pip install --upgrade pip \
    && pip install -r requirements.txt

COPY apps/api /app

EXPOSE 8000

CMD ["bash", "scripts/start.sh"]

