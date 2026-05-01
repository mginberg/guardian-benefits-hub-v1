# Guardian Benefits Hub — V1

New clean-slate V1 for Guardian’s multi-tenant agency platform.

## Architecture (V1)

- **API**: FastAPI (Python) + Postgres
- **Worker**: background jobs (SFTP ingest, GHL sync hooks later)
- **Cache/Queue**: Redis
- **Web**: React + Vite (served via separate build, optionally behind API)

## Local dev (planned)

1. Start infra:

```bash
docker compose up -d
```

2. Start API + worker (two terminals):

```bash
cd apps/api
python -m uvicorn app.main:app --reload --port 8000
```

```bash
cd apps/api
python -m app.worker
```

3. Start web:

```bash
cd apps/web
npm install
npm run dev
```

## Deployment

Deployment is designed for **Render** using `render.yaml`.

