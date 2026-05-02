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

# UNL ships nine upline writing-agent codes on every row as
# agent_level_02 … agent_level_10.  We store them as a JSON array on
# PolicyReport.upline so dashboards can attribute downline retention.
_UPLINE_COLUMNS = tuple(f"agent_level_{i:02d}" for i in range(2, 11))

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
    """Map raw CSV keys to internal field names (case-insensitive, strip whitespace).

    agent_level_02 … agent_level_10 are collapsed into an ordered ``upline``
    list so the full hierarchy chain can be stored as a single JSON blob.
    """
    out: dict = {}
    upline: list[str] = []
    for raw_key, raw_val in row.items():
        key = raw_key.strip().lower().replace(" ", "_")
        val = (raw_val or "").strip()
        if key in _UPLINE_COLUMNS:
            out[key] = val
            upline.append(val)
            continue
        mapped = _COL_MAP.get(key, key)
        out[mapped] = val
    # Trim trailing blanks; keep interior gaps so positions stay aligned.
    while upline and not upline[-1]:
        upline.pop()
    out["upline"] = upline
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
    """Extract 3-character agency prefix from WA code.

    WA codes are formatted like '202NEW01' where digits 3-5 (0-indexed) are
    the agency prefix.  Some codes have extended prefixes like NFYAN — the
    agency is still NFY.
    """
    wa = (wa_code or "").strip()
    if len(wa) < 6:
        return ""
    return wa[3:6].upper()


def _match_prefix_to_agency(prefix: str, prefix_map: dict[str, Agency]) -> Optional[Agency]:
    """Match a WA-code prefix to an agency.

    Handles extended codes like NFYAN by checking progressively shorter
    prefixes: NFYAN → NFYA → NFY.
    """
    if not prefix:
        return None
    if prefix in prefix_map:
        return prefix_map[prefix]
    for length in range(len(prefix) - 1, 1, -1):
        candidate = prefix[:length]
        if candidate in prefix_map:
            return prefix_map[candidate]
    return None


def import_latest_policy_file(db: Session) -> dict:
    files = list_policy_files()
    if not files:
        return {"success": False, "error": "No matching SFTP files found"}

    filename = files[0]["filename"]
    logger.info("downloading unl file %s", filename)
    raw = download_file(filename)
    sha = hashlib.sha256(raw).hexdigest()

    # Idempotent — skip if we already successfully imported this exact file.
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
    del raw  # free memory before processing
    if not rows:
        run.status = ImportRunStatus.failed
        run.finished_at = datetime.now(timezone.utc)
        run.error = "parsed_to_0_rows"
        db.commit()
        return {"success": False, "error": f"{filename} parsed to 0 rows", "file": filename}

    # Build prefix → agency map for all active agencies.
    agencies = db.execute(select(Agency).where(Agency.is_active == True)).scalars().all()  # noqa: E712
    prefix_map: dict[str, Agency] = {a.unl_prefix.upper(): a for a in agencies if a.unl_prefix}

    # Route every row to the correct agency (or quarantine it).
    agency_rows: dict[str, list[dict]] = {}
    unrouted = 0
    for row in rows:
        wa_code = row.get("wa_code", "")
        prefix = _extract_prefix(wa_code)
        agency = _match_prefix_to_agency(prefix, prefix_map)
        if agency:
            agency_rows.setdefault(agency.id, []).append(row)
        else:
            unrouted += 1
            db.add(
                UnroutedPolicyRow(
                    source_file=filename,
                    wa_code=wa_code,
                    extracted_prefix=prefix,
                    row_json=json.dumps(row),
                )
            )

    if unrouted:
        logger.warning("%d rows could not be routed to an agency by WA prefix", unrouted)

    agency_map = {ag.id: ag for ag in agencies}
    routed = 0
    created = 0
    updated = 0
    per_agency: dict = {}
    BATCH_SIZE = 500

    for ag_id, ag_rows in agency_rows.items():
        ag = agency_map.get(ag_id)
        if not ag:
            continue

        ag_created = 0
        ag_updated = 0
        ag_stats: dict[str, int] = {}
        ops_since_commit = 0

        for row in ag_rows:
            issue_dt = parse_date(row.get("issue_date_raw"))
            paid_to_dt = parse_date(row.get("paid_to_date_raw"))
            app_dt = parse_date(row.get("app_received_date_raw"))

            classification, reason = classify_policy(
                {
                    **row,
                    "issue_date": issue_dt,
                    "paid_to_date": paid_to_dt,
                }
            )
            ag_stats[classification] = ag_stats.get(classification, 0) + 1

            existing = db.execute(
                select(PolicyReport).where(
                    PolicyReport.agency_id == ag_id,
                    PolicyReport.policy_number == row.get("policy_number", ""),
                )
            ).scalar_one_or_none()

            prem_raw = row.get("annual_premium", "0")
            try:
                annual_premium = float(str(prem_raw).replace(",", "").replace("$", "").strip() or "0")
            except ValueError:
                annual_premium = 0.0

            upline_json = json.dumps(list(row.get("upline") or []))

            if existing:
                existing.source_file = filename
                existing.imported_at = datetime.now(timezone.utc)
                existing.ga_code = row.get("ga_code", "")
                existing.wa_code = row.get("wa_code", "")
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
                ag_updated += 1
            else:
                db.add(
                    PolicyReport(
                        agency_id=ag_id,
                        source_file=filename,
                        imported_at=datetime.now(timezone.utc),
                        policy_number=row.get("policy_number", ""),
                        wa_code=row.get("wa_code", ""),
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
                ag_created += 1

            ops_since_commit += 1
            # Batch-commit every 500 rows to cap session memory on large files.
            if ops_since_commit >= BATCH_SIZE:
                try:
                    db.commit()
                    db.expire_all()
                except Exception as exc:
                    db.rollback()
                    logger.error("Batch commit failed during policy import: %s", exc)
                    raise
                ops_since_commit = 0

        # Final commit for remainder of this agency's rows.
        db.commit()
        db.expire_all()

        routed += len(ag_rows)
        created += ag_created
        updated += ag_updated

        per_agency[ag.slug] = {
            "name": ag.name,
            "total": len(ag_rows),
            "created": ag_created,
            "updated": ag_updated,
            **ag_stats,
        }

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
