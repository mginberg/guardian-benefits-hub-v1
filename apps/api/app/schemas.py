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
    ghl_agent_field_id: str = ""
    ghl_premium_field_id: str = ""
    ghl_plan_field_id: str = ""
    ghl_field_map: str = "{}"


class AgencyCreateRequest(BaseModel):
    slug: str
    name: str
    unl_prefix: str = ""


class AgencyUpdateRequest(BaseModel):
    name: str | None = None
    is_active: bool | None = None
    unl_prefix: str | None = None
    ghl_location_id: str | None = None
    ghl_agent_field_id: str | None = None
    ghl_premium_field_id: str | None = None
    ghl_plan_field_id: str | None = None
    ghl_field_map: str | None = None


class AgencySetGhlTokenRequest(BaseModel):
    pit_token: str


class PolicyBookSummaryResponse(BaseModel):
    total_policies: int
    total_annual_premium: float
    by_agency: list[dict]
    by_classification: list[dict]


class PolicyBookPolicyRow(BaseModel):
    agency_slug: str
    agency_name: str
    policy_number: str
    wa_code: str
    agent_name: str
    issue_date: str | None = None
    paid_to_date: str | None = None
    annual_premium: float
    classification: str


class PolicyBookPoliciesResponse(BaseModel):
    rows: list[PolicyBookPolicyRow]

