from __future__ import annotations

import csv
import io
import json
import logging
import os
import tempfile
from datetime import datetime, timezone
import hashlib
from typing import Optional

import paramiko
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Agency, ImportRun, ImportRunStatus, PolicyReport, UnroutedPolicyRow
from app.policy_classifier import classify_policy, parse_date


logger = logging.getLogger("unl_sftp")

_COL_MAP: dict[str, str] = {
    "ga":             "ga_code",
    "ga_name":        "ga_name",
    "wa":             "wa_code",
    "wa_name":        "agent_name",
    "plan_code":      "plan_code",
    "issue_date":     "issue_date_raw",
    "cntrct_code":    "cntrct_code",
    "cntrct_reason":  "cntrct_reason",
    "app_recvd_date": "app_received_date_raw",
    "annual_premium": "annual_premium",
    "issue_state":    "issue_state",
    "policy_nbr":     "policy_number",
    "policy_number":  "policy_number",
    "paid_to_date":   "paid_to_date_raw",
    "billing_mode":   "billing_mode",
    "first_name":     "first_name",
    "last_name":      "last_name",
    "zip":            "zip_code",
    "zip_code":       "zip_code",
    "phone_nbr":      "phone",
    "phone":          "phone",
}


def _require_sftp_config() -> None:
    missing = [k for k, v in [
        ("SFTP_HOST", settings.sftp_host),
        ("SFTP_USER", settings.sftp_user),
        ("SFTP_PASSWORD", settings.sftp_password),
    ] if not v]
    if missing:
        raise RuntimeError(f"Missing SFTP config: {', '.join(missing)}")


def list_policy_files() -> list[dict]:
    _require_sftp_config()
    transport = paramiko.Transport((settings.sftp_host, settings.sftp_port))
    transport.connect(username=settings.sftp_user, password=settings.sftp_password)
    sftp = paramiko.SFTPClient.from_transport(transport)
    try:
        out: list[dict] = []
        for attr in sftp.listdir_attr(settings.sftp_remote_dir):
            if settings.sftp_file_pattern in attr.filename and attr.filename.endswith(".csv"):
                out.append({
                    "filename": attr.filename,
                    "size": attr.st_size,
                    "modified": datetime.fromtimestamp(attr.st_mtime or 0, tz=timezone.utc).isoformat()
                    if attr.st_mtime else None,
                })
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
        sftp.get(f"{settings.sftp_remote_dir.rstrip('/')}/{filename}", tmp_path)
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
    out: dict = {}
    for raw_key, raw_val in row.items():
        key = raw_key.strip().lower().replace(" ", "_")
        out[_COL_MAP.get(key, key)] = (raw_val or "").strip()
    return out


def parse_policy_csv(csv_bytes: bytes) -> list[dict]:
    try:
        text = csv_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = csv_bytes.decode("latin-1")
    rows = [_normalize_row(row) for row in csv.DictReader(io.StringIO(text))]
    return [r for r in rows if r.get("policy_number")]


def _extract_prefix(wa_code: str) -> str:
    """Return 3-char agency prefix from position 3-5 of WA code (e.g. '202NEW01' → 'NEW')."""
    wa = (wa_code or "").strip()
    return wa[3:6].upper() if len(wa) >= 6 else ""


def _match_prefix_to_agency(prefix: str, prefix_map: dict[str, Agency]) -> Optional[Agency]:
    """Match prefix to agency, trying progressively shorter strings (NFYAN → NFYA → NFY)."""
    if not prefix:
        return None
    for length in range(len(prefix), 1, -1):
        if agency := prefix_map.get(prefix[:length]):
            return agency
    return None


def _safe_premium(raw) -> float:
    try:
        return float(str(raw).replace(",", "").replace("$", "").strip() or "0")
    except (ValueError, TypeError):
        return 0.0


def upsert_policy_row(
    db: Session,
    *,
    agency_id: str,
    row: dict,
    source_file: str,
    imported_at: datetime,
) -> tuple[bool, str]:
    """Upsert one policy row. Returns (created, classification)."""
    issue_dt = parse_date(row.get("issue_date_raw"))
    paid_to_dt = parse_date(row.get("paid_to_date_raw"))
    app_dt = parse_date(row.get("app_received_date_raw"))
    classification, reason = classify_policy({
        **row,
        "issue_date": issue_dt,
        "paid_to_date": paid_to_dt,
    })
    annual_premium = _safe_premium(row.get("annual_premium", "0"))

    existing = db.execute(
        select(PolicyReport).where(
            PolicyReport.agency_id == agency_id,
            PolicyReport.policy_number == row.get("policy_number", ""),
        )
    ).scalar_one_or_none()

    fields = dict(
        source_file=source_file,
        imported_at=imported_at,
        ga_code=row.get("ga_code", ""),
        wa_code=row.get("wa_code", ""),
        agent_name=row.get("agent_name", ""),
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

    if existing:
        for k, v in fields.items():
            setattr(existing, k, v)
        return False, classification
    else:
        db.add(PolicyReport(
            agency_id=agency_id,
            policy_number=row.get("policy_number", ""),
            **fields,
        ))
        return True, classification


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
    del raw
    if not rows:
        run.status = ImportRunStatus.failed
        run.finished_at = datetime.now(timezone.utc)
        run.error = "parsed_to_0_rows"
        db.commit()
        return {"success": False, "error": f"{filename} parsed to 0 rows", "file": filename}

    agencies = db.execute(select(Agency).where(Agency.is_active == True)).scalars().all()  # noqa: E712
    prefix_map: dict[str, Agency] = {a.unl_prefix.upper(): a for a in agencies if a.unl_prefix}

    agency_rows: dict[str, list[dict]] = {}
    unrouted = 0
    for row in rows:
        agency = _match_prefix_to_agency(_extract_prefix(row.get("wa_code", "")), prefix_map)
        if agency:
            agency_rows.setdefault(agency.id, []).append(row)
        else:
            unrouted += 1
            db.add(UnroutedPolicyRow(
                source_file=filename,
                wa_code=row.get("wa_code", ""),
                extracted_prefix=_extract_prefix(row.get("wa_code", "")),
                row_json=json.dumps(row),
            ))

    if unrouted:
        logger.warning("%d rows could not be routed by WA prefix", unrouted)

    agency_map = {ag.id: ag for ag in agencies}
    routed = created = updated = 0
    per_agency: dict = {}
    BATCH_SIZE = 500

    for ag_id, ag_rows in agency_rows.items():
        ag = agency_map.get(ag_id)
        if not ag:
            continue

        now = datetime.now(timezone.utc)
        ag_created = ag_updated = 0
        ag_stats: dict[str, int] = {}
        ops = 0

        for row in ag_rows:
            was_created, classification = upsert_policy_row(
                db, agency_id=ag_id, row=row, source_file=filename, imported_at=now
            )
            ag_stats[classification] = ag_stats.get(classification, 0) + 1
            if was_created:
                ag_created += 1
            else:
                ag_updated += 1
            ops += 1
            if ops >= BATCH_SIZE:
                db.commit()
                db.expire_all()
                ops = 0

        db.commit()
        db.expire_all()

        routed += len(ag_rows)
        created += ag_created
        updated += ag_updated
        per_agency[ag.slug] = {"name": ag.name, "total": len(ag_rows), "created": ag_created, "updated": ag_updated, **ag_stats}
        logger.info("agency %s: %d rows (%d created, %d updated)", ag.slug, len(ag_rows), ag_created, ag_updated)

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
        "per_agency": per_agency,
    }
