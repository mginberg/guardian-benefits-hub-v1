from pydantic import BaseModel, EmailStr


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class MeResponse(BaseModel):
    user_id: str
    agency_id: str
    role: str
    email: EmailStr
    display_name: str
    impersonated_by: str | None = None


class ImpersonateRequest(BaseModel):
    target_user_id: str
    reason: str

