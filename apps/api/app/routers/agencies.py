from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import AuthContext, forbid_impersonated_writes, require_role
from app.db import get_db
from app.models import Agency
from app.schemas import (
    AgencyCreateRequest,
    AgencyResponse,
    AgencySetGhlTokenRequest,
    AgencyUpdateRequest,
)
from app.security import encrypt_secret


router = APIRouter(prefix="/api/agencies", tags=["agencies"])


def _to_agency_response(a: Agency) -> AgencyResponse:
    return AgencyResponse(
        id=a.id,
        slug=a.slug,
        name=a.name,
        is_active=a.is_active,
        unl_prefix=a.unl_prefix or "",
        ghl_location_id=a.ghl_location_id or "",
        ghl_pit_token_set=bool(a.ghl_pit_token_enc),
        ghl_agent_field_id=a.ghl_agent_field_id or "",
        ghl_premium_field_id=a.ghl_premium_field_id or "",
        ghl_plan_field_id=a.ghl_plan_field_id or "",
        ghl_field_map=a.ghl_field_map or "{}",
    )


@router.get("", response_model=dict)
def list_agencies(
    _ctx: AuthContext = Depends(require_role("super_admin")),
    db: Session = Depends(get_db),
):
    agencies = db.execute(select(Agency).order_by(Agency.slug.asc())).scalars().all()
    return {"agencies": [_to_agency_response(a).model_dump() for a in agencies]}


@router.post("", response_model=AgencyResponse)
def create_agency(
    req: AgencyCreateRequest,
    ctx: AuthContext = Depends(require_role("super_admin")),
    db: Session = Depends(get_db),
):
    forbid_impersonated_writes(ctx)
    a = Agency(
        slug=req.slug.strip(),
        name=req.name.strip(),
        unl_prefix=(req.unl_prefix or "").strip(),
        ghl_location_id="",
        ghl_pit_token_enc="",
        is_active=True,
    )
    db.add(a)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Agency slug already exists")
    db.refresh(a)
    return _to_agency_response(a)


@router.patch("/{agency_id}", response_model=AgencyResponse)
def update_agency(
    agency_id: str,
    req: AgencyUpdateRequest,
    ctx: AuthContext = Depends(require_role("super_admin")),
    db: Session = Depends(get_db),
):
    forbid_impersonated_writes(ctx)
    a = db.execute(select(Agency).where(Agency.id == agency_id)).scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404, detail="Agency not found")

    if req.name is not None:
        a.name = req.name.strip()
    if req.is_active is not None:
        a.is_active = bool(req.is_active)
    if req.unl_prefix is not None:
        a.unl_prefix = (req.unl_prefix or "").strip()
    if req.ghl_location_id is not None:
        a.ghl_location_id = (req.ghl_location_id or "").strip()
    if req.ghl_agent_field_id is not None:
        a.ghl_agent_field_id = (req.ghl_agent_field_id or "").strip()
    if req.ghl_premium_field_id is not None:
        a.ghl_premium_field_id = (req.ghl_premium_field_id or "").strip()
    if req.ghl_plan_field_id is not None:
        a.ghl_plan_field_id = (req.ghl_plan_field_id or "").strip()
    if req.ghl_field_map is not None:
        a.ghl_field_map = (req.ghl_field_map or "{}").strip()

    db.add(a)
    db.commit()
    db.refresh(a)
    return _to_agency_response(a)


@router.put("/{agency_id}/ghl-token", response_model=AgencyResponse)
def set_ghl_pit_token(
    agency_id: str,
    req: AgencySetGhlTokenRequest,
    ctx: AuthContext = Depends(require_role("super_admin")),
    db: Session = Depends(get_db),
):
    forbid_impersonated_writes(ctx)
    a = db.execute(select(Agency).where(Agency.id == agency_id)).scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404, detail="Agency not found")

    pit = (req.pit_token or "").strip()
    if not pit:
        raise HTTPException(status_code=400, detail="pit_token is required")
    a.ghl_pit_token_enc = encrypt_secret(pit)

    db.add(a)
    db.commit()
    db.refresh(a)
    return _to_agency_response(a)

