from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers.auth import router as auth_router
from app.routers.jobs import router as jobs_router
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


@app.get("/api/health")
def health():
    return {"ok": True, "env": settings.env}


app.include_router(auth_router)
app.include_router(jobs_router)
app.include_router(unl_router)

