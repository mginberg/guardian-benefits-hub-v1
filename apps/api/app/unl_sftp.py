from __future__ import annotations

import csv
import io
import json
import logging
import os
import tempfile
from datetime import datetime, timezone
import hashlib

import paramiko
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Agency, ImportRun, ImportRunStatus, PolicyReport, UnroutedPolicyRow
from app.policy_classifier import classify_policy, parse_date


logger = logging.getLogger("unl_sftp")


_COL_MAP: dict[str, str] = {
    "ga": "ga_code",
    "wa": "wa_code",
    "wa_name": "agent_name",
    "plan_code": "plan_code",
    "issue_date": "issue_date_raw",
    "cntrct_code": "cntrct_code",
    "cntrct_reason": "cntrct_reason",
    "app_recvd_date": "app_received_date_raw",
    "annual_premium": "annual_premium",
    "issue_state": "issue_state",
    "policy_nbr": "policy_number",
    "paid_to_date": "paid_to_date_raw",
    "billing_mode": "billing_mode",
    "first_name": "first_name",
    "last_name": "last_name",
    "zip": "zip_code",
    "phone_nbr": "phone",
}


def _require_sftp_config() -> None:
    missing = []
    if not settings.sftp_host:
        missing.append("SFTP_HOST")
    if not settings.sftp_user:
        missing.append("SFTP_USER")
    if not settings.sftp_password:
        missing.append("SFTP_PASSWORD")
    if missing:
        raise RuntimeError(f"Missing SFTP config: {', '.join(missing)}")


def list_policy_files() -> list[dict]:
    _require_sftp_config()
    transport = paramiko.Transport((settings.sftp_host, settings.sftp_port))
    transport.connect(username=settings.sftp_user, password=settings.sftp_password)
    sftp = paramiko.SFTPClient.from_transport(transport)
    try:
        all_files = sftp.listdir_attr(settings.sftp_remote_dir)
        out: list[dict] = []
        for attr in all_files:
            name = attr.filename
            if settings.sftp_file_pattern in name and name.endswith(".csv"):
                out.append(
                    {
                        "filename": name,
                        "size": attr.st_size,
                        "modified": datetime.fromtimestamp(attr.st_mtime or 0, tz=timezone.utc).isoformat()
                        if attr.st_mtime
                        else None,
                    }
                )
        return sorted(out, key=lambda f: f["filename"], reverse=True)
    finally:
        sftp.close()
        transport.close()


def download_file(filename: str) -> bytes:
    _require_sftp_config()
    transport = paramiko.Transport((settings.sftp_host, settings.sftp_port))
    transport.connect(username=settings.sftp_user, password=settings.sftp_password)
    sftp = paramiko.SFTPClient.from_transport(transport)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as tmp:
            tmp_path = tmp.name
        remote_path = f"{settings.sftp_remote_dir.rstrip('/')}/{filename}"
        sftp.get(remote_path, tmp_path)
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        sftp.close()
        transport.close()
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


def _normalize_row(row: dict) -> dict:
    out = {}
    for raw_key, raw_val in row.items():
        key = raw_key.strip().lower().replace(" ", "_")
        mapped = _COL_MAP.get(key, key)
        out[mapped] = (raw_val or "").strip()
    return out


def parse_policy_csv(csv_bytes: bytes) -> list[dict]:
    try:
        text = csv_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = csv_bytes.decode("latin-1")
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for row in reader:
        r = _normalize_row(row)
        if r.get("policy_number"):
            rows.append(r)
    return rows


def _extract_prefix(wa_code: str) -> str:
    wa = (wa_code or "").strip()
    if len(wa) < 6:
        return ""
    return wa[3:6].upper()


def import_latest_policy_file(db: Session) -> dict:
    files = list_policy_files()
    if not files:
        return {"success": False, "error": "No matching SFTP files found"}

    filename = files[0]["filename"]
    logger.info("downloading unl file %s", filename)
    raw = download_file(filename)
    sha = hashlib.sha256(raw).hexdigest()

    existing_run = db.execute(
        select(ImportRun).where(
            ImportRun.import_type == "unl_policy",
            ImportRun.source_sha256 == sha,
            ImportRun.status == ImportRunStatus.succeeded,
        )
    ).scalar_one_or_none()
    if existing_run:
        return {
            "success": True,
            "skipped": True,
            "reason": "already_imported",
            "file": filename,
            "sha256": sha,
            "import_run_id": existing_run.id,
        }

    run = ImportRun(
        import_type="unl_policy",
        source_file=filename,
        source_sha256=sha,
        status=ImportRunStatus.running,
        started_at=datetime.now(timezone.utc),
    )
    db.add(run)
    db.commit()

    rows = parse_policy_csv(raw)
    if not rows:
        run.status = ImportRunStatus.failed
        run.finished_at = datetime.now(timezone.utc)
        run.error = "parsed_to_0_rows"
        db.commit()
        return {"success": False, "error": f"{filename} parsed to 0 rows", "file": filename}

    agencies = db.execute(select(Agency).where(Agency.is_active == True)).scalars().all()  # noqa: E712
    prefix_map = {a.unl_prefix.upper(): a for a in agencies if a.unl_prefix}

    routed = 0
    unrouted = 0
    created = 0
    updated = 0

    for row in rows:
        wa_code = row.get("wa_code", "")
        prefix = _extract_prefix(wa_code)
        agency = prefix_map.get(prefix)

        if not agency:
            unrouted += 1
            db.add(
                UnroutedPolicyRow(
                    source_file=filename,
                    wa_code=wa_code,
                    extracted_prefix=prefix,
                    row_json=json.dumps(row),
                )
            )
            continue

        routed += 1

        issue_dt = parse_date(row.get("issue_date_raw"))
        paid_to_dt = parse_date(row.get("paid_to_date_raw"))
        app_dt = parse_date(row.get("app_received_date_raw"))

        # Classification uses parsed dates.
        classification, reason = classify_policy(
            {
                **row,
                "issue_date": issue_dt,
                "paid_to_date": paid_to_dt,
            }
        )

        existing = db.execute(
            select(PolicyReport).where(
                PolicyReport.agency_id == agency.id,
                PolicyReport.policy_number == row.get("policy_number", ""),
            )
        ).scalar_one_or_none()

        prem_raw = row.get("annual_premium", "0")
        try:
            annual_premium = float(str(prem_raw).replace(",", "").replace("$", "").strip() or "0")
        except ValueError:
            annual_premium = 0.0

        if existing:
            existing.source_file = filename
            existing.imported_at = datetime.now(timezone.utc)
            existing.ga_code = row.get("ga_code", "")
            existing.wa_code = wa_code
            existing.agent_name = row.get("agent_name", "")
            existing.plan_code = row.get("plan_code", "")
            existing.cntrct_code = row.get("cntrct_code", "")
            existing.cntrct_reason = row.get("cntrct_reason", "")
            existing.billing_mode = row.get("billing_mode", "")
            existing.issue_date_raw = row.get("issue_date_raw", "")
            existing.paid_to_date_raw = row.get("paid_to_date_raw", "")
            existing.app_received_date_raw = row.get("app_received_date_raw", "")
            existing.issue_date = issue_dt
            existing.paid_to_date = paid_to_dt
            existing.app_received_date = app_dt
            existing.annual_premium = annual_premium
            existing.issue_state = row.get("issue_state", "")
            existing.first_name = row.get("first_name", "")
            existing.last_name = row.get("last_name", "")
            existing.zip_code = row.get("zip_code", "")
            existing.phone = row.get("phone", "")
            existing.classification = classification
            existing.classification_reason = reason
            updated += 1
        else:
            db.add(
                PolicyReport(
                    agency_id=agency.id,
                    source_file=filename,
                    imported_at=datetime.now(timezone.utc),
                    policy_number=row.get("policy_number", ""),
                    wa_code=wa_code,
                    agent_name=row.get("agent_name", ""),
                    ga_code=row.get("ga_code", ""),
                    plan_code=row.get("plan_code", ""),
                    cntrct_code=row.get("cntrct_code", ""),
                    cntrct_reason=row.get("cntrct_reason", ""),
                    billing_mode=row.get("billing_mode", ""),
                    issue_date_raw=row.get("issue_date_raw", ""),
                    paid_to_date_raw=row.get("paid_to_date_raw", ""),
                    app_received_date_raw=row.get("app_received_date_raw", ""),
                    issue_date=issue_dt,
                    paid_to_date=paid_to_dt,
                    app_received_date=app_dt,
                    annual_premium=annual_premium,
                    issue_state=row.get("issue_state", ""),
                    first_name=row.get("first_name", ""),
                    last_name=row.get("last_name", ""),
                    zip_code=row.get("zip_code", ""),
                    phone=row.get("phone", ""),
                    classification=classification,
                    classification_reason=reason,
                )
            )
            created += 1

    db.commit()
    run.status = ImportRunStatus.succeeded
    run.finished_at = datetime.now(timezone.utc)
    run.total_rows = len(rows)
    run.routed_rows = routed
    run.unrouted_rows = unrouted
    run.created = created
    run.updated = updated
    db.commit()
    return {
        "success": True,
        "file": filename,
        "sha256": sha,
        "import_run_id": run.id,
        "total_rows": len(rows),
        "routed_rows": routed,
        "unrouted_rows": unrouted,
        "created": created,
        "updated": updated,
    }

