from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "development"
    database_url: str = "postgresql+psycopg://guardian:guardian@localhost:5432/guardian_v1"
    redis_url: str = "redis://localhost:6379/0"
    web_origin: str | None = None

    jwt_secret: str = "dev-only-change-me"
    jwt_issuer: str = "guardian-v1"
    jwt_access_token_minutes: int = 60 * 24

    # Used to encrypt sensitive per-agency integration secrets at rest.
    # In production, must be a strong value stored in Render secret env var.
    encryption_key: str = "dev-only-change-me"

    # Bootstrap (first deploy only). In production, required until at least one user exists.
    bootstrap_super_admin_email: str | None = None
    bootstrap_super_admin_password: str | None = None

    # SFTP (UNL). No defaults in production — env must supply.
    sftp_host: str | None = None
    sftp_port: int = 22
    sftp_user: str | None = None
    sftp_password: str | None = None
    sftp_remote_dir: str = "/"
    sftp_file_pattern: str = "GuardianBenefits_Policy_"


settings = Settings()

