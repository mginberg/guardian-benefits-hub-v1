from sqlalchemy import select

from app.config import settings
from app.db import Base, engine, SessionLocal
from app.ids import new_id
from app.models import Agency, User, Role
from app.security import hash_password


def init_db() -> None:
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        email = (getattr(settings, "bootstrap_super_admin_email", None) or "").strip()
        password = (getattr(settings, "bootstrap_super_admin_password", None) or "").strip()

        has_user = db.execute(select(User.id).limit(1)).first() is not None
        if has_user:
            # Allow bootstrap credentials to be used to create / regain access to the super admin,
            # even if the DB already has users (e.g. a previous bootstrap used an invalid email).
            if email and password:
                email_lc = email.lower()
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

                existing = db.execute(select(User).where(User.email == email_lc)).scalar_one_or_none()
                if existing:
                    existing.password_hash = hash_password(password)
                    existing.role = Role.super_admin
                    existing.is_active = True
                else:
                    db.add(
                        User(
                            id=new_id(),
                            agency_id=guardian.id,
                            email=email_lc,
                            display_name="Super Admin",
                            role=Role.super_admin,
                            password_hash=hash_password(password),
                            is_active=True,
                        )
                    )
                db.commit()
            return

        if settings.env == "production" and (not email or not password):
            raise RuntimeError(
                "Bootstrap required: set BOOTSTRAP_SUPER_ADMIN_EMAIL and BOOTSTRAP_SUPER_ADMIN_PASSWORD"
            )

        if not email:
            email = "admin@guardian.local"
        if not password:
            password = "ChangeMe123!"

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

        user = User(
            id=new_id(),
            agency_id=guardian.id,
            email=email.lower(),
            display_name="Super Admin",
            role=Role.super_admin,
            password_hash=hash_password(password),
            is_active=True,
        )
        db.add(user)
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    init_db()

