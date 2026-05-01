from pydantic import BaseModel


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class MeResponse(BaseModel):
    user_id: str
    agency_id: str
    role: str
    email: str
    display_name: str
    impersonated_by: str | None = None


class ImpersonateRequest(BaseModel):
    target_user_id: str
    reason: str

