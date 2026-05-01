from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import AuthContext, get_auth_context, require_role
from app.db import get_db
from app.ids import new_id
from app.models import AuditLog, User
from app.schemas import ImpersonateRequest, LoginRequest, MeResponse, TokenResponse
from app.security import create_access_token, verify_password


router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.execute(
        select(User).where(User.email == req.email.lower())
    ).scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token(sub=user.id, agency_id=user.agency_id, role=user.role.value)
    return TokenResponse(access_token=token)


@router.get("/me", response_model=MeResponse)
def me(ctx: AuthContext = Depends(get_auth_context), db: Session = Depends(get_db)) -> MeResponse:
    user = db.execute(select(User).where(User.id == ctx.user_id)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid session")
    return MeResponse(
        user_id=user.id,
        agency_id=user.agency_id,
        role=ctx.role,
        email=user.email,
        display_name=user.display_name,
        impersonated_by=ctx.impersonated_by,
    )


@router.post("/impersonate", response_model=TokenResponse)
def impersonate(
    req: ImpersonateRequest,
    ctx: AuthContext = Depends(require_role("super_admin")),
    db: Session = Depends(get_db),
) -> TokenResponse:
    target = db.execute(select(User).where(User.id == req.target_user_id)).scalar_one_or_none()
    if not target or not target.is_active:
        raise HTTPException(status_code=404, detail="Target user not found")

    # Issue a token scoped to the target, with an audit trail.
    token = create_access_token(
        sub=target.id,
        agency_id=target.agency_id,
        role=target.role.value,
        extra={"impersonated_by": ctx.user_id},
    )

    db.add(
        AuditLog(
            id=new_id(),
            actor_user_id=ctx.user_id,
            actor_role=ctx.role,
            agency_id=target.agency_id,
            action="impersonate",
            target=target.id,
            meta_json=json.dumps({"reason": req.reason}),
        )
    )
    db.commit()

    return TokenResponse(access_token=token)

