from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from typing import Any

from cryptography.fernet import Fernet
from jose import jwt
from passlib.context import CryptContext

from app.config import settings


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def _bcrypt_secret(password: str) -> str:
    # bcrypt only considers the first 72 bytes of the password.
    # passlib's bcrypt backend errors if the UTF-8 encoded value exceeds that limit.
    raw = password.encode("utf-8")
    if len(raw) <= 72:
        return password
    return raw[:72].decode("utf-8", errors="ignore")


def hash_password(password: str) -> str:
    return pwd_context.hash(_bcrypt_secret(password))


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(_bcrypt_secret(password), password_hash)


def _jwt_now() -> datetime:
    return datetime.now(timezone.utc)


def create_access_token(*, sub: str, agency_id: str, role: str, extra: dict[str, Any] | None = None) -> str:
    now = _jwt_now()
    exp = now + timedelta(minutes=settings.jwt_access_token_minutes)
    payload: dict[str, Any] = {
        "iss": settings.jwt_issuer,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "sub": sub,
        "agency_id": agency_id,
        "role": role,
        **(extra or {}),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def _fernet() -> Fernet:
    # Settings value can be an arbitrary string (Render generateValue); normalize to a Fernet key.
    raw = settings.encryption_key.encode("utf-8")
    key = base64.urlsafe_b64encode(raw.ljust(32, b"\0")[:32])
    return Fernet(key)


def encrypt_secret(plaintext: str) -> str:
    if not plaintext:
        return ""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_secret(ciphertext: str) -> str:
    if not ciphertext:
        return ""
    return _fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")

