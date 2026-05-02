import enum
from datetime import datetime, date

from sqlalchemy import (
    String,
    DateTime,
    Boolean,
    ForeignKey,
    Integer,
    Float,
    Text,
    Date,
    Enum,
    UniqueConstraint,
    Index,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.ids import new_id


def utcnow() -> datetime:
    return datetime.utcnow()


class Role(str, enum.Enum):
    super_admin = "super_admin"
    admin = "admin"
    agent = "agent"


class Agency(Base):
    __tablename__ = "agencies"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    slug: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # UNL routing prefix (WA code 3 chars at pos 4-6, e.g. "NEW")
    unl_prefix: Mapped[str] = mapped_column(String, default="", index=True)

    # GHL config (pit_token is encrypted at rest)
    ghl_location_id: Mapped[str] = mapped_column(String, default="")
    ghl_pit_token_enc: Mapped[str] = mapped_column(Text, default="")

    # GHL custom field IDs for leaderboard (per-agency, override defaults)
    # If empty, DEFAULT_GHL_FIELD_MAP fallbacks are used (from ghl_client.py)
    ghl_agent_field_id: Mapped[str] = mapped_column(String, default="")    # field ID for agent name
    ghl_premium_field_id: Mapped[str] = mapped_column(String, default="")  # field ID for monthly premium
    ghl_plan_field_id: Mapped[str] = mapped_column(String, default="")     # field ID for plan name
    # JSON blob for any additional field ID overrides {"key": "ghl_field_id", ...}
    ghl_field_map: Mapped[str] = mapped_column(Text, default="{}")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    users = relationship("User", back_populates="agency")


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    agency_id: Mapped[str] = mapped_column(String, ForeignKey("agencies.id"), index=True)
    email: Mapped[str] = mapped_column(String, index=True)
    display_name: Mapped[str] = mapped_column(String, default="")
    role: Mapped[Role] = mapped_column(Enum(Role), default=Role.agent)
    password_hash: Mapped[str] = mapped_column(String, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    agency = relationship("Agency", back_populates="users")

    __table_args__ = (
        UniqueConstraint("agency_id", "email", name="uq_users_agency_email"),
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    actor_user_id: Mapped[str] = mapped_column(String, index=True)
    actor_role: Mapped[str] = mapped_column(String, default="")
    agency_id: Mapped[str] = mapped_column(String, index=True)
    action: Mapped[str] = mapped_column(String, index=True)
    target: Mapped[str] = mapped_column(String, default="")
    meta_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class PolicyReport(Base):
    __tablename__ = "policy_reports"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    agency_id: Mapped[str] = mapped_column(String, ForeignKey("agencies.id"), index=True)

    source_file: Mapped[str] = mapped_column(String, default="")
    imported_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    policy_number: Mapped[str] = mapped_column(String, index=True)
    wa_code: Mapped[str] = mapped_column(String, default="", index=True)
    agent_name: Mapped[str] = mapped_column(String, default="", index=True)
    ga_code: Mapped[str] = mapped_column(String, default="")

    plan_code: Mapped[str] = mapped_column(String, default="")
    cntrct_code: Mapped[str] = mapped_column(String, default="")
    cntrct_reason: Mapped[str] = mapped_column(String, default="")
    billing_mode: Mapped[str] = mapped_column(String, default="")

    issue_date_raw: Mapped[str] = mapped_column(String, default="")
    paid_to_date_raw: Mapped[str] = mapped_column(String, default="")
    app_received_date_raw: Mapped[str] = mapped_column(String, default="")

    issue_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    paid_to_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    app_received_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)

    annual_premium: Mapped[float] = mapped_column(Float, default=0.0)
    issue_state: Mapped[str] = mapped_column(String, default="")

    first_name: Mapped[str] = mapped_column(String, default="")
    last_name: Mapped[str] = mapped_column(String, default="")
    zip_code: Mapped[str] = mapped_column(String, default="")
    phone: Mapped[str] = mapped_column(String, default="")

    classification: Mapped[str] = mapped_column(String, default="unknown", index=True)
    classification_reason: Mapped[str] = mapped_column(Text, default="")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    __table_args__ = (
        UniqueConstraint("agency_id", "policy_number", name="uq_policy_reports_agency_policy"),
        Index("ix_policy_reports_agency_class", "agency_id", "classification"),
    )


class LeaderboardContact(Base):
    """One row per GHL contact (= one deal submission). Upserted on webhook or cron sync."""
    __tablename__ = "leaderboard_contacts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    agency_id: Mapped[str] = mapped_column(String, ForeignKey("agencies.id"), index=True)
    ghl_location_id: Mapped[str] = mapped_column(String, default="", index=True)
    ghl_contact_id: Mapped[str] = mapped_column(String, default="", index=True)

    # Denormalised leaderboard fields
    agent_name: Mapped[str] = mapped_column(String, default="", index=True)
    premium: Mapped[float] = mapped_column(Float, default=0.0)
    plan_name: Mapped[str] = mapped_column(String, default="")
    issue_state: Mapped[str] = mapped_column(String, default="")

    # Contact info
    contact_first_name: Mapped[str] = mapped_column(String, default="")
    contact_last_name: Mapped[str] = mapped_column(String, default="")

    # GHL creation timestamp — this is what filters today/week/month
    ghl_date_added: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)

    # Source tracking: webhook | ghl_sync | deal_submission
    source: Mapped[str] = mapped_column(String, default="ghl_sync")

    last_synced_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    agency = relationship("Agency")

    __table_args__ = (
        UniqueConstraint("ghl_location_id", "ghl_contact_id", name="uq_lb_contact_location_ghl"),
        Index("ix_lb_contact_agency_date", "agency_id", "ghl_date_added"),
    )


class UnroutedPolicyRow(Base):
    __tablename__ = "unrouted_policy_rows"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    source_file: Mapped[str] = mapped_column(String, default="", index=True)
    wa_code: Mapped[str] = mapped_column(String, default="", index=True)
    extracted_prefix: Mapped[str] = mapped_column(String, default="", index=True)
    row_json: Mapped[str] = mapped_column(Text, default="{}")
    imported_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


# ── Commission sync models ─────────────────────────────────────────────────────

class CommissionStatementType(str, enum.Enum):
    WA = "WA"
    WC = "WC"
    MC = "MC"
    master_WA = "master_WA"
    master_WC = "master_WC"
    master_MC = "master_MC"


class CommissionSyncLog(Base):
    """One row per CSV upload (per-agency or master)."""
    __tablename__ = "commission_sync_logs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    agency_id: Mapped[str] = mapped_column(String, ForeignKey("agencies.id"), index=True)
    statement_type: Mapped[str] = mapped_column(String, index=True)   # WA / WC / MC / master_*
    file_name: Mapped[str] = mapped_column(String, default="")
    total_rows: Mapped[int] = mapped_column(Integer, default=0)
    matched_rows: Mapped[int] = mapped_column(Integer, default=0)
    unmatched_rows: Mapped[int] = mapped_column(Integer, default=0)
    chargeback_rows: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    records = relationship("CommissionRecord", back_populates="sync_log")
    unmatched = relationship("CommissionUnmatched", back_populates="sync_log")


class CommissionRecord(Base):
    """One row per policy per statement source (WA/WC/MC), upserted on each upload."""
    __tablename__ = "commission_records"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    agency_id: Mapped[str] = mapped_column(String, ForeignKey("agencies.id"), index=True)
    sync_log_id: Mapped[str] = mapped_column(String, ForeignKey("commission_sync_logs.id"), index=True)

    policy_number: Mapped[str] = mapped_column(String, index=True)
    ghl_contact_id: Mapped[str] = mapped_column(String, default="", index=True)
    statement_source: Mapped[str] = mapped_column(String, default="")   # WA | WC | MC

    # Agent info
    agent_nbr: Mapped[str] = mapped_column(String, default="")
    agent_name_full: Mapped[str] = mapped_column(String, default="")
    insured_name: Mapped[str] = mapped_column(String, default="")

    # Transaction
    trans_type: Mapped[str] = mapped_column(String, default="")
    plan_code: Mapped[str] = mapped_column(String, default="")

    # Amounts
    prem_paid_amt: Mapped[float] = mapped_column(Float, default=0.0)
    monthly_premium: Mapped[float] = mapped_column(Float, default=0.0)
    comm_rate: Mapped[float] = mapped_column(Float, default=0.0)
    comm_prem_amt: Mapped[float] = mapped_column(Float, default=0.0)
    adv_per: Mapped[float] = mapped_column(Float, default=0.0)
    advance_amount: Mapped[float] = mapped_column(Float, default=0.0)
    earned_commission: Mapped[float] = mapped_column(Float, default=0.0)
    net_owed: Mapped[float] = mapped_column(Float, default=0.0)

    # MC-specific amounts
    mc_comm_amt: Mapped[float] = mapped_column(Float, default=0.0)
    mc_comm_amt_due: Mapped[float] = mapped_column(Float, default=0.0)
    mc_retained_recovery: Mapped[float] = mapped_column(Float, default=0.0)
    mc_code: Mapped[str] = mapped_column(String, default="")
    mc_trans_type: Mapped[str] = mapped_column(String, default="")

    # WC-specific
    wc_trans_type: Mapped[str] = mapped_column(String, default="")
    wc_code: Mapped[str] = mapped_column(String, default="")

    # Dates
    effective_date: Mapped[str] = mapped_column(String, default="")
    paid_to_date: Mapped[str] = mapped_column(String, default="")
    last_activity_date: Mapped[str] = mapped_column(String, default="")

    # Status
    status: Mapped[str] = mapped_column(String, default="active", index=True)  # active | chargeback
    chargeback_amount: Mapped[float] = mapped_column(Float, default=0.0)
    chargeback_date: Mapped[str] = mapped_column(String, default="")
    plan_status: Mapped[str] = mapped_column(String, default="")

    # Location / product
    issue_state: Mapped[str] = mapped_column(String, default="")
    policy_form: Mapped[str] = mapped_column(String, default="")

    # Payroll flags (never touched by commission upload — payroll module only)
    paid_to_agent: Mapped[bool] = mapped_column(Boolean, default=False)
    paid_to_agent_date: Mapped[str] = mapped_column(String, default="")
    payroll_run_id: Mapped[str] = mapped_column(String, default="")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    sync_log = relationship("CommissionSyncLog", back_populates="records")

    __table_args__ = (
        UniqueConstraint("agency_id", "policy_number", "statement_source",
                         name="uq_commission_agency_policy_source"),
        Index("ix_commission_agency_status", "agency_id", "status"),
    )


class CommissionUnmatched(Base):
    """Policy rows from CSV that could not be matched to a GHL contact."""
    __tablename__ = "commission_unmatched"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    agency_id: Mapped[str] = mapped_column(String, ForeignKey("agencies.id"), index=True)
    sync_log_id: Mapped[str] = mapped_column(String, ForeignKey("commission_sync_logs.id"), index=True)
    policy_number: Mapped[str] = mapped_column(String, default="", index=True)
    raw_data: Mapped[str] = mapped_column(Text, default="{}")
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    sync_log = relationship("CommissionSyncLog", back_populates="unmatched")


class JobStatus(str, enum.Enum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    agency_id: Mapped[str] = mapped_column(String, ForeignKey("agencies.id"), index=True)
    created_by_user_id: Mapped[str] = mapped_column(String, index=True)

    job_type: Mapped[str] = mapped_column(String, index=True)
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.queued, index=True)

    params_json: Mapped[str] = mapped_column(Text, default="{}")
    result_json: Mapped[str] = mapped_column(Text, default="{}")
    error: Mapped[str] = mapped_column(Text, default="")

    queued_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    locked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    lock_token: Mapped[str] = mapped_column(String, default="")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    __table_args__ = (
        Index("ix_jobs_status_queued", "status", "queued_at"),
    )


class ImportRunStatus(str, enum.Enum):
    running = "running"
    succeeded = "succeeded"
    failed = "failed"


class ImportRun(Base):
    __tablename__ = "import_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    import_type: Mapped[str] = mapped_column(String, index=True)  # unl_policy
    source_file: Mapped[str] = mapped_column(String, index=True)
    source_sha256: Mapped[str] = mapped_column(String, index=True)

    status: Mapped[ImportRunStatus] = mapped_column(Enum(ImportRunStatus), default=ImportRunStatus.running, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str] = mapped_column(Text, default="")

    total_rows: Mapped[int] = mapped_column(Integer, default=0)
    routed_rows: Mapped[int] = mapped_column(Integer, default=0)
    unrouted_rows: Mapped[int] = mapped_column(Integer, default=0)
    created: Mapped[int] = mapped_column(Integer, default=0)
    updated: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (
        UniqueConstraint("import_type", "source_sha256", name="uq_import_runs_type_sha"),
    )

