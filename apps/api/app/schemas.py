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


class BootstrapResetRequest(BaseModel):
    bootstrap_password: str
    email: str
    password: str


class AgencyResponse(BaseModel):
    id: str
    slug: str
    name: str
    is_active: bool
    unl_prefix: str
    ghl_location_id: str
    ghl_pit_token_set: bool


class AgencyCreateRequest(BaseModel):
    slug: str
    name: str
    unl_prefix: str = ""


class AgencyUpdateRequest(BaseModel):
    name: str | None = None
    is_active: bool | None = None
    unl_prefix: str | None = None
    ghl_location_id: str | None = None


class AgencySetGhlTokenRequest(BaseModel):
    pit_token: str

