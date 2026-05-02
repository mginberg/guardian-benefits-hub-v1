from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db_init import init_db
from app.routers.commission_sync import router as commission_sync_router
from app.routers.agencies import router as agencies_router
from app.routers.auth import router as auth_router
from app.routers.jobs import router as jobs_router
from app.routers.leaderboard import router as leaderboard_router
from app.routers.policy_book import router as policy_book_router
from app.routers.policy_reports import router as policy_reports_router
from app.routers.unl import router as unl_router


app = FastAPI(title="Guardian Benefits Hub V1", version="0.1.0")

allowed_origins = ["*"] if settings.env != "production" else []
if settings.env == "production" and settings.web_origin:
    allowed_origins = [settings.web_origin]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/api/health")
def health():
    return {"ok": True, "env": settings.env}


app.include_router(commission_sync_router)
app.include_router(auth_router)
app.include_router(jobs_router)
app.include_router(unl_router)
app.include_router(agencies_router)
app.include_router(leaderboard_router)
app.include_router(policy_book_router)
app.include_router(policy_reports_router)

