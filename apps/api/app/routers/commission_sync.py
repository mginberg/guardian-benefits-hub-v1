"""Commission sync router.

Supports per-agency and master (Guardian super-admin) CSV uploads for
WA, WC, and MC statement types. Writes matched fields back to GHL
using dedicated per-type custom field IDs. Never overwrites — each
statement type has its own GHL fields.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select, delete
from sqlalchemy.orm import Session

from app.auth import AuthContext, get_auth_context, require_roles
from app.db import get_db
from app.ghl_client import get_pit_token
from app.ids import new_id
from app.models import (
    Agency, CommissionRecord, CommissionSyncLog, CommissionUnmatched, Role
)

logger = logging.getLogger("commission_sync")

router = APIRouter(prefix="/api/commission-sync", tags=["commission-sync"])

# ── GHL custom field IDs (from original DEFAULT_GHL_FIELD_MAP) ────────────────
FIELD_IDS: dict[str, str] = {
    "policy_number":       "MElxhb8gTHUIQocxEEkQ",
    "advance_amount":      "q5z0A796B4jUnVv9US1k",
    "remaining_balance":   "N0KnchcCY3fEBZYAnxHV",
    "chargeback_amount":   "QJgzP0GqVyhll3cr8KIU",
    "chargeback_date":     "gyg3JYNhYbtnQZ5Vcyop",
    "commission_status":   "LNoWiWTg92rkolJBkztb",
    "statement_source":    "A0oZL350ZJYhNBiZbpXS",
    "commission_rate":     "JiUFZAiO8SzkFyUXopty",
    "advance_percentage":  "r74wzO3wvjKVqmrYut9c",
    "comm_prem_amount":    "rKuEYEYl0NkG81qimUDv",
    "wc_transaction_type": "tYliNPccskWloeBNixuL",
    "wc_transaction_code": "2v0dogmOgu9MCyN8sEBo",
    "transaction_type":    "ALsMi8ysjekXvTZzczAH",
    "transaction_code":    "dfFvcY66KJWwCNt6Y9zh",
    "transaction_reason":  "XX0i8CuoRB24gqPGkjiW",
    "code_reason":         "G6pdntdobUtj4XVyDddx",
    "mc_comm_amt":         "rgZ6EkcjxMOSP5fSIB0H",
    "mc_comm_amt_due":     "ob1OzOcQFbPAOVijJn7q",
    "issue_state":         "0yYbYHqtFmAQpyTdZLqg",
    "policy_form":         "zsRKQPcRxHzFaAuSvSjw",
    "paid_to_date":        "qVGFQxOz1xavRVcPBKTQ",
    "last_activity_date":  "GEnPBcSAVulSLSNeyqGS",
    "agent_number":        "cFNdv8fXu87YQrZkguOz",
    "plan_status":         "OBPeU3lZ067152TeUair",
    "months_active":       "DZ0lUs253YG9uPua0ETn",
    "earned_commission":   "wqCstKDthwHOG87uXuAZ",
    "net_owed":            "0RYUfoBcTxngr6kmaPOz",
    "paid_to_agent_date":  "F2crQXrwE1uwsODFps77",
    "advance_status":      "btnNR721AH5xeovfIzLh",
    "advance_payment_made":"Zv2aGtMr7K7xfULE6nmV",
}

# WC / MC transaction code labels
TRANS_TYPE_LABELS: dict[str, str] = {
    "1": "New Policy", "2": "Reinstatement", "C": "Cancel", "F": "Flat Cancel",
    "I": "Cancel-Reissue", "O": "NSF", "N": "Stop Pay", "S": "Other Bank",
    "R": "Account Closed",
}
CODE_LABELS: dict[str, str] = {
    "O": "NSF", "N": "Stop Pay", "S": "Other Bank", "R": "Account Closed",
    "C": "Canceled", "F": "Flat Cancel", "I": "Cancel-Reissue",
}

CANCEL_TRANS     = {"C", "F", "I"}
PAYMENT_ISSUE    = {"O", "N", "S", "R"}
REINSTATEMENT    = {"2"}
SKIP_MC_TRANS    = {"8", "9"}

GHL_CONCURRENCY = 10
GHL_TIMEOUT     = 20


# ── helpers ───────────────────────────────────────────────────────────────────

def _today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _fld(key: str, value: Any) -> dict:
    """Build a GHL customField entry."""
    fid = FIELD_IDS.get(key, "")
    if not fid:
        return {}
    return {"id": fid, "value": str(value)}


def _plan_status_for_problem(effective_date: str, statement_date: str) -> str:
    if not effective_date or not statement_date:
        return "Non Effectuated"
    try:
        eff = datetime.strptime(effective_date, "%Y-%m-%d")
        stmt = datetime.strptime(statement_date, "%Y-%m-%d")
        if (stmt - eff).days > 31:
            return "Chargeback"
    except Exception:
        pass
    return "Non Effectuated"


def _extract_statement_date(filename: str) -> str:
    """Extract MM-DD-YYYY from filename and convert to YYYY-MM-DD."""
    m = re.search(r"(\d{2})-(\d{2})-(\d{4})", filename or "")
    if m:
        return f"{m.group(3)}-{m.group(1)}-{m.group(2)}"
    return ""


def _normalize_key(k: str) -> str:
    return k.strip().lower().replace(" ", "_")


def _parse_float(v: Any) -> float:
    try:
        return float(str(v).replace(",", "").strip() or 0)
    except Exception:
        return 0.0


async def _build_policy_map(pit_token: str, location_id: str) -> dict[str, dict]:
    """Fetch all GHL contacts and build policy_number → {contact_id, first_name, last_name}."""
    policy_map: dict[str, dict] = {}
    policy_field_id = FIELD_IDS["policy_number"]
    after_cursor: str | None = None
    page = 0
    MAX_PAGES = 200

    async with httpx.AsyncClient(timeout=GHL_TIMEOUT) as client:
        while page < MAX_PAGES:
            params: dict[str, Any] = {
                "locationId": location_id,
                "limit": 100,
            }
            if after_cursor:
                params["startAfter"] = after_cursor
                params["startAfterId"] = after_cursor

            resp = await client.get(
                "https://services.leadconnectorhq.com/contacts/",
                headers={"Authorization": f"Bearer {pit_token}", "Version": "2021-07-28"},
                params=params,
            )
            if resp.status_code == 429:
                await asyncio.sleep(2)
                continue
            if resp.status_code != 200:
                break

            data = resp.json()
            contacts = data.get("contacts", [])
            if not contacts:
                break

            for c in contacts:
                cid = c.get("id", "")
                cf = c.get("customFields") or []
                for field in cf:
                    if field.get("id") == policy_field_id:
                        pnum = str(field.get("value") or "").strip()
                        if pnum:
                            policy_map[pnum] = {
                                "contact_id": cid,
                                "first_name": c.get("firstName", ""),
                                "last_name": c.get("lastName", ""),
                            }
                        break

            meta = data.get("meta", {})
            after_cursor = meta.get("startAfterId") or meta.get("nextPageUrl")
            if not after_cursor or len(contacts) < 100:
                break
            page += 1

    return policy_map


async def _ghl_update_contact(
    client: httpx.AsyncClient,
    pit_token: str,
    contact_id: str,
    fields: list[dict],
) -> None:
    if not fields or not contact_id:
        return
    payload = {"customFields": [f for f in fields if f]}
    try:
        resp = await client.put(
            f"https://services.leadconnectorhq.com/contacts/{contact_id}",
            headers={"Authorization": f"Bearer {pit_token}", "Version": "2021-07-28"},
            json=payload,
        )
        if resp.status_code == 429:
            await asyncio.sleep(1)
            await client.put(
                f"https://services.leadconnectorhq.com/contacts/{contact_id}",
                headers={"Authorization": f"Bearer {pit_token}", "Version": "2021-07-28"},
                json=payload,
            )
    except Exception as e:
        logger.warning("GHL update failed for %s: %s", contact_id, e)


async def _run_ghl_updates(pit_token: str, updates: list[tuple[str, list[dict]]]) -> None:
    sem = asyncio.Semaphore(GHL_CONCURRENCY)
    async with httpx.AsyncClient(timeout=GHL_TIMEOUT) as client:
        async def _one(cid: str, fields: list[dict]) -> None:
            async with sem:
                await _ghl_update_contact(client, pit_token, cid, fields)
        await asyncio.gather(*[_one(cid, f) for cid, f in updates])


def _upsert_record(db: Session, agency_id: str, sync_log_id: str, data: dict) -> None:
    """Upsert a CommissionRecord. Paid-to-agent rows skip DB update but GHL still fires."""
    existing = db.execute(
        select(CommissionRecord).where(
            CommissionRecord.agency_id == agency_id,
            CommissionRecord.policy_number == data["policy_number"],
            CommissionRecord.statement_source == data["statement_source"],
        )
    ).scalar_one_or_none()

    if existing:
        if existing.paid_to_agent:
            return  # preserve payroll-paid rows
        for k, v in data.items():
            setattr(existing, k, v)
        existing.sync_log_id = sync_log_id
    else:
        rec = CommissionRecord(id=new_id(), agency_id=agency_id, sync_log_id=sync_log_id, **data)
        db.add(rec)


# ── WA processing ─────────────────────────────────────────────────────────────

def _aggregate_wa_rows(rows: list[dict]) -> dict[str, dict]:
    agg: dict[str, dict] = {}
    for row in rows:
        nrow = {_normalize_key(k): v for k, v in row.items()}
        pnum = (nrow.get("policy_nbr") or nrow.get("policy_number") or "").strip()
        if not pnum or len(pnum) < 5:
            continue
        amount = _parse_float(nrow.get("amount", 0))
        prem   = _parse_float(nrow.get("prem_paid_amt", 0))
        cprem  = _parse_float(nrow.get("comm_prem_amt", 0))
        if pnum not in agg:
            agg[pnum] = {
                "policy_number": pnum,
                "advance_amount": 0.0, "prem_paid_amt": 0.0, "comm_prem_amt": 0.0,
                "agent_nbr": nrow.get("agent_nbr", ""),
                "first_name": nrow.get("first_name", ""),
                "last_name":  nrow.get("last_name", ""),
                "plan_code":  nrow.get("plan", nrow.get("plan_code", "")),
                "trans_type": nrow.get("trans_type", ""),
                "comm_rate":  _parse_float(nrow.get("comm_rate", 0)),
                "adv_per":    _parse_float(nrow.get("adv_per", 0)),
                "effective_date":    nrow.get("effective_date", ""),
                "paid_to_date":      nrow.get("paid_to_date", ""),
                "last_activity_date": nrow.get("last_activity_date", ""),
            }
        agg[pnum]["advance_amount"] += amount
        agg[pnum]["prem_paid_amt"]  += prem
        agg[pnum]["comm_prem_amt"]  += cprem
    return agg


async def _process_wa_upload(
    rows: list[dict], agency: Agency, pit_token: str,
    policy_map: dict, db: Session, sync_log_id: str,
) -> dict:
    agg = _aggregate_wa_rows(rows)
    matched = unmatched = chargebacks = 0
    ghl_updates: list[tuple[str, list[dict]]] = []
    today = _today_str()

    for pnum, p in agg.items():
        is_cb = p["advance_amount"] < 0
        monthly = round(p["prem_paid_amt"] / 12, 2)
        adv_abs = round(abs(p["advance_amount"]), 2)

        fields: list[dict] = [
            _fld("advance_amount",    adv_abs),
            _fld("commission_rate",   p["comm_rate"]),
            _fld("advance_percentage",p["adv_per"]),
            _fld("comm_prem_amount",  round(p["comm_prem_amt"], 2)),
            _fld("paid_to_date",      p["paid_to_date"] or today),
            _fld("last_activity_date",p["last_activity_date"] or today),
            _fld("agent_number",      p["agent_nbr"]),
            _fld("commission_status", "chargeback" if is_cb else "active"),
            _fld("earned_commission", monthly),
            _fld("chargeback_amount", adv_abs if is_cb else "0"),
            _fld("chargeback_date",   (p["last_activity_date"] or "") if is_cb else ""),
            _fld("months_active",     "0"),
            _fld("statement_source",  "WA"),
            _fld("plan_status",       "Non Effectuated" if is_cb else "Active"),
            _fld("net_owed",          round(abs(p["advance_amount"]) - monthly, 2) if is_cb else "0"),
        ]
        fields = [f for f in fields if f]

        contact = policy_map.get(pnum)
        if contact:
            matched += 1
            ghl_updates.append((contact["contact_id"], fields))
        else:
            unmatched += 1
            db.add(CommissionUnmatched(
                id=new_id(), agency_id=agency.id, sync_log_id=sync_log_id,
                policy_number=pnum, raw_data=json.dumps(p),
            ))

        if is_cb:
            chargebacks += 1

        _upsert_record(db, agency.id, sync_log_id, {
            "policy_number": pnum,
            "ghl_contact_id": (contact or {}).get("contact_id", ""),
            "statement_source": "WA",
            "agent_nbr": p["agent_nbr"],
            "agent_name_full": f"{p['first_name']} {p['last_name']}".strip(),
            "insured_name": f"{p['first_name']} {p['last_name']}".strip(),
            "trans_type": p["trans_type"],
            "plan_code": p["plan_code"],
            "prem_paid_amt": p["prem_paid_amt"],
            "monthly_premium": monthly,
            "comm_rate": p["comm_rate"],
            "comm_prem_amt": p["comm_prem_amt"],
            "adv_per": p["adv_per"],
            "advance_amount": adv_abs,
            "earned_commission": monthly,
            "net_owed": round(abs(p["advance_amount"]) - monthly, 2) if is_cb else 0.0,
            "effective_date": p["effective_date"],
            "paid_to_date": p["paid_to_date"] or today,
            "last_activity_date": p["last_activity_date"] or today,
            "status": "chargeback" if is_cb else "active",
            "chargeback_amount": adv_abs if is_cb else 0.0,
            "chargeback_date": (p["last_activity_date"] or "") if is_cb else "",
            "plan_status": "Non Effectuated" if is_cb else "Active",
        })

    db.flush()
    if ghl_updates and pit_token:
        await _run_ghl_updates(pit_token, ghl_updates)

    return {"matched": matched, "unmatched": unmatched, "chargebacks": chargebacks, "total": len(agg)}


# ── WC processing ─────────────────────────────────────────────────────────────

def _aggregate_wc_rows(rows: list[dict]) -> dict[str, dict]:
    agg: dict[str, dict] = {}
    for row in rows:
        nrow = {_normalize_key(k): v for k, v in row.items()}
        pnum = (nrow.get("policy_nbr") or nrow.get("policy_number") or "").strip()
        if not pnum or len(pnum) < 5:
            continue
        comm_amt  = _parse_float(nrow.get("comm_amt") or nrow.get("amount", 0))
        comm_prem = _parse_float(nrow.get("comm_prem_amt", 0))
        prem_paid = _parse_float(nrow.get("prem_paid_amt", 0))
        trans = (nrow.get("trans_type") or "").strip()
        code  = (nrow.get("code") or "").strip()

        if pnum not in agg:
            agg[pnum] = {
                "policy_number": pnum,
                "comm_amt": 0.0, "comm_prem_amt": 0.0, "prem_paid_amt": 0.0,
                "has_negative": False,
                "trans_type": trans, "code": code,
                "agent_nbr": nrow.get("agent_nbr", ""),
                "first_name": nrow.get("first_name", ""),
                "last_name":  nrow.get("last_name", ""),
                "comm_rate":  _parse_float(nrow.get("comm_rate", 0)),
                "effective_date":    nrow.get("effective_date", ""),
                "paid_to_date":      nrow.get("paid_to_date", ""),
                "last_activity_date": nrow.get("last_activity_date") or nrow.get("effective_date", ""),
            }
        agg[pnum]["comm_amt"]      += comm_amt
        agg[pnum]["comm_prem_amt"] += comm_prem
        agg[pnum]["prem_paid_amt"] += prem_paid
        if comm_prem < 0 or comm_amt < 0:
            agg[pnum]["has_negative"] = True
        # Prefer "bad" trans types
        if trans and trans not in REINSTATEMENT and (
            trans in CANCEL_TRANS or trans in PAYMENT_ISSUE
        ):
            agg[pnum]["trans_type"] = trans
        if code and not agg[pnum]["code"]:
            agg[pnum]["code"] = code
    return agg


async def _process_wc_upload(
    rows: list[dict], agency: Agency, pit_token: str,
    policy_map: dict, db: Session, sync_log_id: str, stmt_date: str,
) -> dict:
    agg = _aggregate_wc_rows(rows)
    matched = unmatched = chargebacks = 0
    ghl_updates: list[tuple[str, list[dict]]] = []
    today = _today_str()

    for pnum, p in agg.items():
        wc_trans = p["trans_type"]
        is_reinstate = wc_trans in REINSTATEMENT
        is_cb = (not is_reinstate) and (
            p["has_negative"] or wc_trans in CANCEL_TRANS or wc_trans in PAYMENT_ISSUE
        )
        monthly = round(p["prem_paid_amt"] / 12, 2)
        cb_amt  = round(abs(p["comm_amt"]), 2) if is_cb else 0.0

        trans_label = TRANS_TYPE_LABELS.get(wc_trans, wc_trans)
        code_label  = CODE_LABELS.get(p["code"], p["code"]) if p["code"] else ""
        plan_st = _plan_status_for_problem(p["effective_date"], stmt_date) if is_cb else "Active"

        fields: list[dict] = [
            _fld("commission_rate",   p["comm_rate"]),
            _fld("comm_prem_amount",  round(p["comm_prem_amt"], 2)),
            _fld("chargeback_amount", cb_amt),
            _fld("chargeback_date",   (p["last_activity_date"] or "") if is_cb else ""),
            _fld("paid_to_date",      p["paid_to_date"] or today),
            _fld("last_activity_date",p["last_activity_date"] or today),
            _fld("agent_number",      p["agent_nbr"]),
            _fld("commission_status", "chargeback" if is_cb else "active"),
            _fld("earned_commission", monthly),
            _fld("months_active",     "0"),
            _fld("statement_source",  "WC"),
            _fld("plan_status",       plan_st),
            _fld("wc_transaction_type", trans_label),
            _fld("wc_transaction_code", code_label),
        ]
        fields = [f for f in fields if f]

        contact = policy_map.get(pnum)
        if contact:
            matched += 1
            ghl_updates.append((contact["contact_id"], fields))
        else:
            unmatched += 1
            db.add(CommissionUnmatched(
                id=new_id(), agency_id=agency.id, sync_log_id=sync_log_id,
                policy_number=pnum, raw_data=json.dumps(p),
            ))

        if is_cb:
            chargebacks += 1

        _upsert_record(db, agency.id, sync_log_id, {
            "policy_number": pnum,
            "ghl_contact_id": (contact or {}).get("contact_id", ""),
            "statement_source": "WC",
            "agent_nbr": p["agent_nbr"],
            "agent_name_full": f"{p['first_name']} {p['last_name']}".strip(),
            "insured_name": f"{p['first_name']} {p['last_name']}".strip(),
            "trans_type": p["trans_type"],
            "wc_trans_type": wc_trans,
            "wc_code": p["code"],
            "prem_paid_amt": p["prem_paid_amt"],
            "monthly_premium": monthly,
            "comm_rate": p["comm_rate"],
            "comm_prem_amt": p["comm_prem_amt"],
            "earned_commission": monthly,
            "effective_date": p["effective_date"],
            "paid_to_date": p["paid_to_date"] or today,
            "last_activity_date": p["last_activity_date"] or today,
            "status": "chargeback" if is_cb else "active",
            "chargeback_amount": cb_amt,
            "chargeback_date": (p["last_activity_date"] or "") if is_cb else "",
            "plan_status": plan_st,
        })

    db.flush()
    if ghl_updates and pit_token:
        await _run_ghl_updates(pit_token, ghl_updates)

    return {"matched": matched, "unmatched": unmatched, "chargebacks": chargebacks, "total": len(agg)}


# ── MC processing ─────────────────────────────────────────────────────────────

def _aggregate_mc_rows(rows: list[dict]) -> dict[str, dict]:
    agg: dict[str, dict] = {}
    for row in rows:
        nrow = {_normalize_key(k): v for k, v in row.items()}
        pnum = (nrow.get("policy_nbr") or nrow.get("policy_number") or "").strip()
        if not pnum or len(pnum) < 5:
            continue
        trans = (nrow.get("trans_type") or "").strip()
        if trans in SKIP_MC_TRANS:
            continue

        comm_amt  = _parse_float(nrow.get("comm_amt") or nrow.get("amount", 0))
        retained  = _parse_float(nrow.get("retained_or_recovery") or nrow.get("retained", 0))
        amt_due   = _parse_float(nrow.get("comm_amt_due", 0))
        comm_prem = _parse_float(nrow.get("comm_prem_amt", 0))
        prem_paid = _parse_float(nrow.get("prem_paid_amt", 0))
        code      = (nrow.get("code") or "").strip()

        if pnum not in agg:
            agg[pnum] = {
                "policy_number": pnum,
                "mc_comm_amt": 0.0, "mc_retained_recovery": 0.0, "mc_comm_amt_due": 0.0,
                "comm_prem_amt": 0.0, "prem_paid_amt": 0.0,
                "has_negative_comm_prem": False,
                "mc_trans_type": trans, "mc_code": code,
                "agent_nbr": nrow.get("agent_nbr", ""),
                "first_name": nrow.get("first_name", ""),
                "last_name":  nrow.get("last_name", ""),
                "comm_rate":  _parse_float(nrow.get("comm_rate", 0)),
                "issue_state":   nrow.get("issue_state", ""),
                "policy_form":   nrow.get("policy_form", ""),
                "effective_date":    nrow.get("effective_date", ""),
                "paid_to_date":      nrow.get("paid_to_date", ""),
                "last_activity_date": nrow.get("last_activity_date", ""),
            }
        agg[pnum]["mc_comm_amt"]          += comm_amt
        agg[pnum]["mc_retained_recovery"] += retained
        agg[pnum]["mc_comm_amt_due"]      += amt_due
        agg[pnum]["comm_prem_amt"]        += comm_prem
        agg[pnum]["prem_paid_amt"]        += prem_paid
        if comm_prem < 0:
            agg[pnum]["has_negative_comm_prem"] = True
        # Prefer non-"1" trans types
        if trans and trans != "1":
            agg[pnum]["mc_trans_type"] = trans
        if code and not agg[pnum]["mc_code"]:
            agg[pnum]["mc_code"] = code
    return agg


async def _process_mc_upload(
    rows: list[dict], agency: Agency, pit_token: str,
    policy_map: dict, db: Session, sync_log_id: str, stmt_date: str,
) -> dict:
    agg = _aggregate_mc_rows(rows)
    matched = unmatched = chargebacks = 0
    ghl_updates: list[tuple[str, list[dict]]] = []
    today = _today_str()

    for pnum, p in agg.items():
        mc_trans  = p["mc_trans_type"]
        is_reinstate = mc_trans in REINSTATEMENT
        is_cb = (not is_reinstate) and (
            mc_trans in CANCEL_TRANS or mc_trans in PAYMENT_ISSUE or p["has_negative_comm_prem"]
        )
        monthly = round(p["prem_paid_amt"] / 12, 2)
        cb_amt  = round(abs(p["mc_comm_amt"]), 2) if is_cb else 0.0
        plan_st = _plan_status_for_problem(p["effective_date"], stmt_date) if is_cb else "Active"

        trans_label = TRANS_TYPE_LABELS.get(mc_trans, mc_trans)
        code_label  = CODE_LABELS.get(p["mc_code"], p["mc_code"]) if p["mc_code"] else ""

        fields: list[dict] = [
            _fld("commission_rate",   p["comm_rate"]),
            _fld("comm_prem_amount",  round(p["comm_prem_amt"], 2)),
            _fld("transaction_type",  mc_trans),
            _fld("transaction_code",  p["mc_code"]),
            _fld("transaction_reason",trans_label),
            _fld("code_reason",       code_label),
            _fld("chargeback_amount", cb_amt),
            _fld("chargeback_date",   (p["paid_to_date"] or "") if is_cb else ""),
            _fld("paid_to_date",      p["paid_to_date"] or today),
            _fld("last_activity_date",today),
            _fld("agent_number",      p["agent_nbr"]),
            _fld("issue_state",       p["issue_state"]),
            _fld("policy_form",       p["policy_form"]),
            _fld("commission_status", "chargeback" if is_cb else "active"),
            _fld("earned_commission", monthly),
            _fld("mc_comm_amt",       round(p["mc_comm_amt"], 2)),
            _fld("mc_comm_amt_due",   round(p["mc_comm_amt_due"], 2)),
            _fld("months_active",     "0"),
            _fld("statement_source",  "MC"),
            _fld("plan_status",       plan_st),
        ]
        fields = [f for f in fields if f]

        contact = policy_map.get(pnum)
        if contact:
            matched += 1
            ghl_updates.append((contact["contact_id"], fields))
        else:
            unmatched += 1
            db.add(CommissionUnmatched(
                id=new_id(), agency_id=agency.id, sync_log_id=sync_log_id,
                policy_number=pnum, raw_data=json.dumps(p),
            ))

        if is_cb:
            chargebacks += 1

        _upsert_record(db, agency.id, sync_log_id, {
            "policy_number": pnum,
            "ghl_contact_id": (contact or {}).get("contact_id", ""),
            "statement_source": "MC",
            "agent_nbr": p["agent_nbr"],
            "agent_name_full": f"{p['first_name']} {p['last_name']}".strip(),
            "insured_name": f"{p['first_name']} {p['last_name']}".strip(),
            "trans_type": mc_trans,
            "mc_trans_type": mc_trans,
            "mc_code": p["mc_code"],
            "prem_paid_amt": p["prem_paid_amt"],
            "monthly_premium": monthly,
            "comm_rate": p["comm_rate"],
            "comm_prem_amt": p["comm_prem_amt"],
            "mc_comm_amt": p["mc_comm_amt"],
            "mc_comm_amt_due": p["mc_comm_amt_due"],
            "mc_retained_recovery": p["mc_retained_recovery"],
            "earned_commission": monthly,
            "issue_state": p["issue_state"],
            "policy_form": p["policy_form"],
            "effective_date": p["effective_date"],
            "paid_to_date": p["paid_to_date"] or today,
            "last_activity_date": today,
            "status": "chargeback" if is_cb else "active",
            "chargeback_amount": cb_amt,
            "chargeback_date": (p["paid_to_date"] or "") if is_cb else "",
            "plan_status": plan_st,
        })

    db.flush()
    if ghl_updates and pit_token:
        await _run_ghl_updates(pit_token, ghl_updates)

    return {"matched": matched, "unmatched": unmatched, "chargebacks": chargebacks, "total": len(agg)}


def _detect_statement_type(filename: str) -> str | None:
    fn = filename.upper()
    if "_WA_" in fn or fn.startswith("WA_") or fn.endswith("_WA.CSV"):
        return "WA"
    if "_WC_" in fn or fn.startswith("WC_") or fn.endswith("_WC.CSV"):
        return "WC"
    if "_MC_" in fn or fn.startswith("MC_") or fn.endswith("_MC.CSV"):
        return "MC"
    return None


def _parse_csv(content: bytes) -> list[dict]:
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    return [{k.strip(): v for k, v in row.items()} for row in reader]


def _extract_agency_prefix_from_agent_nbr(agent_nbr: str) -> str:
    """Extract alphabetic agency prefix from agent number (e.g. '202NEW01' → 'NEW')."""
    m = re.search(r"[A-Z]{2,}", agent_nbr.upper())
    return m.group(0) if m else ""


def _find_agency_by_prefix(db: Session, prefix: str) -> Agency | None:
    if not prefix:
        return None
    agencies = db.execute(select(Agency).where(Agency.is_active == True)).scalars().all()
    # Longest prefix match against agency.unl_prefix
    best: Agency | None = None
    best_len = 0
    for ag in agencies:
        up = ag.unl_prefix.upper()
        if up and prefix.startswith(up) and len(up) > best_len:
            best = ag
            best_len = len(up)
    return best


# ── API endpoints ─────────────────────────────────────────────────────────────

@router.post("/{agency_slug}/upload")
async def upload_commission(
    agency_slug: str,
    files: list[UploadFile] = File(...),
    statement_type: str = Form(default=""),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    """Upload one or more commission CSV files for a specific agency."""
    agency = db.execute(select(Agency).where(Agency.slug == agency_slug)).scalar_one_or_none()
    if not agency:
        raise HTTPException(404, "Agency not found")

    # Admins can only upload for their own agency; super_admin can upload for any
    if ctx.role != Role.super_admin and ctx.agency_id != agency.id:
        raise HTTPException(403, "Forbidden")

    pit_token = get_pit_token(agency)
    policy_map = await _build_policy_map(pit_token, agency.ghl_location_id) if pit_token else {}

    results = []
    for upload in files:
        content = await upload.read()
        rows = _parse_csv(content)
        stype = statement_type or _detect_statement_type(upload.filename or "") or "WA"

        sync_log = CommissionSyncLog(
            id=new_id(), agency_id=agency.id,
            statement_type=stype, file_name=upload.filename or "",
            total_rows=len(rows),
        )
        db.add(sync_log)
        db.flush()

        # Clean up prior non-paid rows for this source before upserting
        db.execute(
            delete(CommissionRecord).where(
                CommissionRecord.agency_id == agency.id,
                CommissionRecord.statement_source == stype,
                CommissionRecord.paid_to_agent == False,
            )
        )

        stmt_date = _extract_statement_date(upload.filename or "")
        if stype == "WA":
            r = await _process_wa_upload(rows, agency, pit_token, policy_map, db, sync_log.id)
        elif stype == "WC":
            r = await _process_wc_upload(rows, agency, pit_token, policy_map, db, sync_log.id, stmt_date)
        else:
            r = await _process_mc_upload(rows, agency, pit_token, policy_map, db, sync_log.id, stmt_date)

        sync_log.total_rows     = r["total"]
        sync_log.matched_rows   = r["matched"]
        sync_log.unmatched_rows = r["unmatched"]
        sync_log.chargeback_rows= r["chargebacks"]
        db.commit()
        results.append({"file": upload.filename, "type": stype, **r})

    return {"results": results}


@router.post("/master-upload")
async def master_upload(
    files: list[UploadFile] = File(...),
    ctx: AuthContext = Depends(require_roles(Role.super_admin)),
    db: Session = Depends(get_db),
):
    """Guardian master upload — splits rows by agent number → agency prefix."""
    results = []

    for upload in files:
        content = await upload.read()
        rows = _parse_csv(content)
        stype = _detect_statement_type(upload.filename or "") or "WA"
        master_type = f"master_{stype}"
        stmt_date = _extract_statement_date(upload.filename or "")

        # Group rows by agency
        agency_rows: dict[str, list[dict]] = {}
        unrouted: list[dict] = []
        for row in rows:
            nrow = {_normalize_key(k): v for k, v in row.items()}
            agent_nbr = nrow.get("agent_nbr", "")
            prefix = _extract_agency_prefix_from_agent_nbr(agent_nbr)
            ag = _find_agency_by_prefix(db, prefix)
            if ag:
                agency_rows.setdefault(ag.id, []).append(row)
            else:
                unrouted.append(row)

        file_results: dict[str, Any] = {
            "file": upload.filename, "type": master_type,
            "unrouted": len(unrouted), "agencies": [],
        }

        for agency_id, ag_rows in agency_rows.items():
            agency = db.get(Agency, agency_id)
            if not agency:
                continue

            pit_token = get_pit_token(agency)
            policy_map = await _build_policy_map(pit_token, agency.ghl_location_id) if pit_token else {}

            sync_log = CommissionSyncLog(
                id=new_id(), agency_id=agency.id,
                statement_type=master_type, file_name=upload.filename or "",
                total_rows=len(ag_rows),
            )
            db.add(sync_log)
            db.flush()

            if stype == "WA":
                r = await _process_wa_upload(ag_rows, agency, pit_token, policy_map, db, sync_log.id)
            elif stype == "WC":
                r = await _process_wc_upload(ag_rows, agency, pit_token, policy_map, db, sync_log.id, stmt_date)
            else:
                r = await _process_mc_upload(ag_rows, agency, pit_token, policy_map, db, sync_log.id, stmt_date)

            sync_log.total_rows      = r["total"]
            sync_log.matched_rows    = r["matched"]
            sync_log.unmatched_rows  = r["unmatched"]
            sync_log.chargeback_rows = r["chargebacks"]
            db.commit()
            file_results["agencies"].append({"agency": agency.name, **r})

        results.append(file_results)

    return {"results": results}


@router.get("/{agency_slug}/records")
def get_records(
    agency_slug: str,
    status: str = "",
    source: str = "",
    search: str = "",
    offset: int = 0,
    limit: int = 100,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    agency = db.execute(select(Agency).where(Agency.slug == agency_slug)).scalar_one_or_none()
    if not agency:
        raise HTTPException(404, "Agency not found")
    if ctx.role != Role.super_admin and ctx.agency_id != agency.id:
        raise HTTPException(403, "Forbidden")

    q = select(CommissionRecord).where(CommissionRecord.agency_id == agency.id)
    if status:
        q = q.where(CommissionRecord.status == status)
    if source:
        q = q.where(CommissionRecord.statement_source == source)
    if search:
        s = f"%{search}%"
        from sqlalchemy import or_
        q = q.where(or_(
            CommissionRecord.policy_number.ilike(s),
            CommissionRecord.insured_name.ilike(s),
            CommissionRecord.agent_name_full.ilike(s),
        ))

    total = db.execute(q.with_only_columns(CommissionRecord.id)).all()
    recs = db.execute(q.order_by(CommissionRecord.updated_at.desc()).offset(offset).limit(limit)).scalars().all()

    return {
        "total": len(total),
        "records": [
            {
                "id": r.id,
                "policy_number": r.policy_number,
                "agent": r.agent_name_full,
                "insured": r.insured_name,
                "monthly_premium": r.monthly_premium,
                "advance_amount": r.advance_amount,
                "earned_commission": r.earned_commission,
                "status": r.status,
                "source": r.statement_source,
                "effective_date": r.effective_date,
                "chargeback_amount": r.chargeback_amount,
                "chargeback_date": r.chargeback_date,
                "plan_status": r.plan_status,
                "trans_type": r.trans_type,
                "paid_to_agent": r.paid_to_agent,
            }
            for r in recs
        ],
    }


@router.get("/{agency_slug}/analytics")
def get_analytics(
    agency_slug: str,
    period: str = "all",
    source: str = "",
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    agency = db.execute(select(Agency).where(Agency.slug == agency_slug)).scalar_one_or_none()
    if not agency:
        raise HTTPException(404, "Agency not found")
    if ctx.role != Role.super_admin and ctx.agency_id != agency.id:
        raise HTTPException(403, "Forbidden")

    from datetime import timedelta
    from sqlalchemy import func

    q = select(CommissionRecord).where(CommissionRecord.agency_id == agency.id)
    if source:
        q = q.where(CommissionRecord.statement_source == source)

    now = datetime.now(timezone.utc)
    if period == "week":
        cutoff = now - timedelta(days=7)
        q = q.where(CommissionRecord.updated_at >= cutoff)
    elif period == "month":
        cutoff = now - timedelta(days=30)
        q = q.where(CommissionRecord.updated_at >= cutoff)

    recs = db.execute(q).scalars().all()

    total = len(recs)
    active = [r for r in recs if r.status == "active"]
    chargebacks = [r for r in recs if r.status == "chargeback"]

    return {
        "total_records": total,
        "active_count": len(active),
        "chargeback_count": len(chargebacks),
        "active_premium": round(sum(r.monthly_premium for r in active), 2),
        "chargeback_amount": round(sum(r.chargeback_amount for r in chargebacks), 2),
        "earned_commission": round(sum(r.earned_commission for r in recs), 2),
        "by_source": {
            src: {
                "count": len([r for r in recs if r.statement_source == src]),
                "chargebacks": len([r for r in recs if r.statement_source == src and r.status == "chargeback"]),
            }
            for src in ["WA", "WC", "MC"]
        },
    }


@router.get("/{agency_slug}/logs")
def get_logs(
    agency_slug: str,
    limit: int = 20,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    agency = db.execute(select(Agency).where(Agency.slug == agency_slug)).scalar_one_or_none()
    if not agency:
        raise HTTPException(404, "Agency not found")
    if ctx.role != Role.super_admin and ctx.agency_id != agency.id:
        raise HTTPException(403, "Forbidden")

    logs = db.execute(
        select(CommissionSyncLog)
        .where(CommissionSyncLog.agency_id == agency.id)
        .order_by(CommissionSyncLog.created_at.desc())
        .limit(limit)
    ).scalars().all()

    return [
        {
            "id": l.id, "statement_type": l.statement_type, "file_name": l.file_name,
            "total_rows": l.total_rows, "matched_rows": l.matched_rows,
            "unmatched_rows": l.unmatched_rows, "chargeback_rows": l.chargeback_rows,
            "created_at": l.created_at.isoformat() if l.created_at else None,
        }
        for l in logs
    ]


@router.get("/{agency_slug}/unmatched")
def get_unmatched(
    agency_slug: str,
    limit: int = 200,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
):
    agency = db.execute(select(Agency).where(Agency.slug == agency_slug)).scalar_one_or_none()
    if not agency:
        raise HTTPException(404, "Agency not found")
    if ctx.role != Role.super_admin and ctx.agency_id != agency.id:
        raise HTTPException(403, "Forbidden")

    rows = db.execute(
        select(CommissionUnmatched)
        .where(CommissionUnmatched.agency_id == agency.id, CommissionUnmatched.resolved == False)
        .order_by(CommissionUnmatched.created_at.desc())
        .limit(limit)
    ).scalars().all()

    return [
        {
            "id": r.id, "policy_number": r.policy_number,
            "raw_data": json.loads(r.raw_data or "{}"),
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
