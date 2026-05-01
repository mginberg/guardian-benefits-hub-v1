from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import AuthContext, get_auth_context, require_role
from app.config import settings
from app.db import get_db
from app.ids import new_id
from app.models import Agency, AuditLog, Role, User
from app.schemas import BootstrapResetRequest, ImpersonateRequest, LoginRequest, MeResponse, TokenResponse
from app.security import create_access_token, hash_password, verify_password


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


@router.post("/bootstrap-reset")
def bootstrap_reset(req: BootstrapResetRequest, db: Session = Depends(get_db)) -> dict:
    """
    One-time escape hatch to regain access during early bootstrapping.
    This endpoint is gated by BOOTSTRAP_SUPER_ADMIN_PASSWORD.
    """
    if not settings.bootstrap_super_admin_password:
        raise HTTPException(status_code=400, detail="Bootstrap password is not configured")
    if req.bootstrap_password != settings.bootstrap_super_admin_password:
        raise HTTPException(status_code=401, detail="Invalid bootstrap password")

    email_lc = req.email.strip().lower()
    guardian = db.execute(select(Agency).where(Agency.slug == "guardian")).scalar_one_or_none()
    if not guardian:
        guardian = Agency(
            id=new_id(),
            slug="guardian",
            name="Guardian Benefits",
            unl_prefix="",
            ghl_location_id="",
            ghl_pit_token_enc="",
            is_active=True,
        )
        db.add(guardian)
        db.flush()

    user = (
        db.execute(select(User).where(User.agency_id == guardian.id, User.email == email_lc))
        .scalar_one_or_none()
    )
    if not user:
        user = User(
            id=new_id(),
            agency_id=guardian.id,
            email=email_lc,
            display_name="Super Admin",
            role=Role.super_admin,
            password_hash=hash_password(req.password),
            is_active=True,
        )
        db.add(user)
    else:
        user.password_hash = hash_password(req.password)
        user.role = Role.super_admin
        user.is_active = True

    db.commit()
    return {"ok": True, "email": email_lc}


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

