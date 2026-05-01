from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import jwt, JWTError

from app.config import settings


bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthContext:
    user_id: str
    agency_id: str
    role: str
    impersonated_by: str | None = None


def get_auth_context(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer),
) -> AuthContext:
    if not creds:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    token = creds.credentials
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"], issuer=settings.jwt_issuer)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user_id = str(payload.get("sub") or "")
    agency_id = str(payload.get("agency_id") or "")
    role = str(payload.get("role") or "")
    impersonated_by = payload.get("impersonated_by")

    if not user_id or not agency_id or not role:
        raise HTTPException(status_code=401, detail="Invalid token claims")

    return AuthContext(
        user_id=user_id,
        agency_id=agency_id,
        role=role,
        impersonated_by=str(impersonated_by) if impersonated_by else None,
    )


def require_role(*allowed: str):
    allowed_set = set(allowed)

    def _dep(ctx: AuthContext = Depends(get_auth_context)) -> AuthContext:
        if ctx.role not in allowed_set:
            raise HTTPException(status_code=403, detail="Forbidden")
        return ctx

    return _dep


def forbid_impersonated_writes(ctx: AuthContext) -> None:
    # V1 guardrail: when impersonating, we only allow read-only access by default.
    if ctx.impersonated_by:
        raise HTTPException(status_code=403, detail="Impersonation is read-only in V1")

