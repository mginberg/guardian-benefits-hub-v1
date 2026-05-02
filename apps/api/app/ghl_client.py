"""
GHL (GoHighLevel) API client for V1.

Ported from the original guardian-benefits-hub backend/app/ghl.py with
the improvements that prevented OOM on large sub-accounts:

- ALL field IDs are DB-driven via get_field_map(agency) — no hardcoded names
- Cursor-based GET /contacts/ pagination (POST /contacts/search caps at ~800)
- Streaming generator: yields one contact at a time so peak RAM = one GHL page
- Exponential backoff on 429 rate limits
- Hard page cap (MAX_PAGES = 200) to prevent runaway locations

The OOM root cause in the original: contacts were loaded into a Python list
eagerly. Streaming fixes this — each page is processed and discarded before
the next is fetched, so RAM usage is O(1) regardless of location size.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Optional

import httpx

from app.models import Agency
from app.security import decrypt_secret

log = logging.getLogger(__name__)

GHL_BASE = "https://services.leadconnectorhq.com"
GHL_VERSION = "2021-07-28"

# Hard ceiling: 200 pages × 100 contacts/page = 20 k contacts per location.
# Prevents a runaway location from OOM-ing the worker.
MAX_PAGES = 200


# ── Default field IDs (Guardian Benefits GHL sub-account) ─────────────────
# Per-agency overrides are layered on top via get_field_map(agency).
# These IDs are from the primary Guardian Benefits GHL location.
DEFAULT_FIELD_MAP: dict[str, str] = {
    "agent_name":         "vnvXADl6hMkqRrKIkyvw",   # "Agent Name" custom field
    "monthly_premium":    "dKIrCNiUvpHV7o2IVNLQ",   # "Monthly Premium"
    "plan_name":          "QE4TstnSBeYlHBWmX5ML",    # "Plan Name"
    # Extended commission / policy fields
    "policy_number":      "MElxhb8gTHUIQocxEEkQ",
    "effective_date":     "4tkii3SJAY5AQlZ6r3iY",
    "premium_draft_date": "8g00Mw1VS2Xrwj3ZwXwb",
    "advance_status":     "btnNR721AH5xeovfIzLh",
    "advance_amount":     "q5z0A796B4jUnVv9US1k",
    "chargeback_amount":  "QJgzP0GqVyhll3cr8KIU",
    "chargeback_date":    "gyg3JYNhYbtnQZ5Vcyop",
    "commission_status":  "LNoWiWTg92rkolJBkztb",
    "statement_source":   "A0oZL350ZJYhNBiZbpXS",
    "issue_state":        "0yYbYHqtFmAQpyTdZLqg",
}


def get_field_map(agency: Agency) -> dict[str, str]:
    """Return merged field map: defaults < agency.ghl_field_map < explicit columns.

    Priority (highest wins):
      3. agency.ghl_agent_field_id / ghl_premium_field_id / ghl_plan_field_id
      2. agency.ghl_field_map  (JSON blob of per-agency overrides)
      1. DEFAULT_FIELD_MAP     (Guardian Benefits defaults)
    """
    base = {**DEFAULT_FIELD_MAP}

    # Layer 2: per-agency JSON overrides
    try:
        overrides = json.loads(agency.ghl_field_map or "{}")
        if isinstance(overrides, dict):
            base.update(overrides)
    except (json.JSONDecodeError, TypeError):
        pass

    # Layer 3: explicit per-agency columns (highest priority)
    if agency.ghl_agent_field_id:
        base["agent_name"] = agency.ghl_agent_field_id
    if agency.ghl_premium_field_id:
        base["monthly_premium"] = agency.ghl_premium_field_id
    if agency.ghl_plan_field_id:
        base["plan_name"] = agency.ghl_plan_field_id

    return base


# ── HTTP helpers ────────────────────────────────────────────────────────────

def _headers(pit_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {pit_token}",
        "Version": GHL_VERSION,
        "Content-Type": "application/json",
    }


async def _api_call_with_retry(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    max_attempts: int = 3,
    **kwargs: Any,
) -> httpx.Response:
    """Execute a GHL API call with exponential back-off on 429 rate limits."""
    for attempt in range(max_attempts):
        resp = await client.request(method, url, **kwargs)
        if resp.status_code == 429:
            wait = 2.0 * (attempt + 1)
            log.warning("GHL rate limited (429) on %s — waiting %.1fs (attempt %d)", url, wait, attempt + 1)
            await asyncio.sleep(wait)
            continue
        return resp
    # Final attempt
    return await client.request(method, url, **kwargs)


# ── Field extraction ────────────────────────────────────────────────────────

def extract_field_by_id(custom_fields: list, field_id: str) -> Optional[str]:
    """Extract a GHL custom field value by its unique field ID."""
    for cf in custom_fields:
        if cf.get("id") == field_id:
            val = cf.get("value")
            if val is None:
                return None
            if isinstance(val, list):
                return ", ".join(str(v) for v in val)
            return str(val)
    return None


def _parse_premium(value: Optional[str]) -> float:
    if not value:
        return 0.0
    try:
        return float(str(value).replace("$", "").replace(",", "").strip())
    except (ValueError, TypeError):
        return 0.0


def _parse_contact_date(contact: dict, tz_offset_hours: int = -4) -> Optional[datetime]:
    """Parse GHL contact dateAdded/createdAt to a timezone-aware datetime."""
    raw = contact.get("dateAdded") or contact.get("createdAt") or ""
    if not raw:
        return None
    try:
        if "T" in raw:
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return datetime.strptime(raw, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _parse_ghl_timestamp(val: Any) -> Optional[str]:
    """Convert GHL custom field date (epoch seconds or ISO) to YYYY-MM-DD."""
    if val is None:
        return None
    if isinstance(val, (int, float)) and val > 1_000_000_000:
        ts = val / 1000 if val > 1_700_000_000_000 else val
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
    val_str = str(val).strip()
    if not val_str:
        return None
    if val_str.isdigit() and len(val_str) >= 10:
        ts = int(val_str)
        if ts > 1_700_000_000_000:
            ts //= 1000
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
    if "T" in val_str:
        return val_str[:10]
    if len(val_str) >= 10 and val_str[:4].isdigit() and "-" in val_str[:10]:
        return val_str[:10]
    return None


# ── Slim contact extraction ─────────────────────────────────────────────────

class SlimContact:
    """Lightweight struct for one GHL contact — only fields the leaderboard needs."""
    __slots__ = (
        "agent_name", "premium", "date", "issue_state", "plan_name",
        "contact_first_name", "contact_last_name",
        "policy_number", "effective_date", "premium_draft_date",
        "advance_status", "advance_amount",
        "chargeback_amount", "chargeback_date",
        "commission_status", "statement_source",
    )

    def __init__(self, **kw: Any) -> None:
        for k, v in kw.items():
            setattr(self, k, v)


def slim_contact(raw: dict, field_map: dict[str, str]) -> Optional[SlimContact]:
    """Extract leaderboard fields from a raw GHL contact dict.

    Returns None if agent_name is empty (contact is not a closed deal).
    This filter is critical — GHL locations contain marketing/junk contacts
    that should not appear on the leaderboard.
    """
    cf = raw.get("customFields") or []
    if not isinstance(cf, list):
        return None

    def _fv(key: str) -> str:
        fid = field_map.get(key, "")
        return (extract_field_by_id(cf, fid) or "").strip() if fid else ""

    agent_name = _fv("agent_name")
    if not agent_name:
        return None  # not a closed deal

    premium = _parse_premium(_fv("monthly_premium"))
    date = _parse_contact_date(raw)
    state = (raw.get("state") or raw.get("address1State") or "").strip()
    plan_name = _fv("plan_name")

    return SlimContact(
        agent_name=agent_name,
        premium=premium,
        date=date,
        issue_state=state,
        plan_name=plan_name,
        contact_first_name=(raw.get("firstName") or "").strip(),
        contact_last_name=(raw.get("lastName") or "").strip(),
        policy_number=_fv("policy_number"),
        effective_date=_parse_ghl_timestamp(_fv("effective_date")),
        premium_draft_date=_parse_ghl_timestamp(_fv("premium_draft_date")),
        advance_status=_fv("advance_status"),
        advance_amount=_parse_premium(_fv("advance_amount")),
        chargeback_amount=_parse_premium(_fv("chargeback_amount")),
        chargeback_date=_parse_ghl_timestamp(_fv("chargeback_date")),
        commission_status=_fv("commission_status"),
        statement_source=_fv("statement_source"),
    )


# ── Streaming paginator ─────────────────────────────────────────────────────

async def stream_qualified_contacts(
    pit_token: str,
    location_id: str,
    field_map: dict[str, str],
) -> AsyncGenerator[tuple[str, SlimContact], None]:
    """Async generator — paginate GHL /contacts/ and yield only contacts
    that have agent_name populated (i.e. closed deal contacts).

    Each batch is processed and **discarded** before the next fetch so
    peak memory is bounded to one GHL page (~100 contacts) regardless of
    how large the location has grown.  This is the fix for the original
    OOM crash on the Guardian + Medigap shared location.

    Yields: (contact_id, SlimContact)
    """
    hdrs = _headers(pit_token)
    params: dict[str, Any] = {"locationId": location_id, "limit": 100}
    pages = 0

    async with httpx.AsyncClient(timeout=60.0) as client:
        while pages < MAX_PAGES:
            resp = await _api_call_with_retry(
                client, "GET", f"{GHL_BASE}/contacts/",
                headers=hdrs, params=params,
            )
            if resp.status_code != 200:
                log.warning(
                    "GHL /contacts/ %s for location %s (page %d) — stopping",
                    resp.status_code, location_id, pages,
                )
                return

            data = resp.json()
            batch: list[dict] = data.get("contacts", [])
            if not batch:
                return
            pages += 1

            for raw in batch:
                sc = slim_contact(raw, field_map)
                if sc is not None:
                    yield raw.get("id", ""), sc

            # Cursor-based pagination (GHL uses startAfterId + startAfter)
            meta: dict = data.get("meta", {})
            next_id = meta.get("startAfterId")
            next_after = meta.get("startAfter")
            page_full = len(batch) >= 100

            # Explicitly free the large objects before next network call
            del batch, data, resp

            if not next_id or not next_after or not page_full:
                return

            params["startAfterId"] = next_id
            params["startAfter"] = next_after

    log.warning(
        "Pagination hit MAX_PAGES=%d for location %s — truncating",
        MAX_PAGES, location_id,
    )


def get_pit_token(agency: Agency) -> Optional[str]:
    """Decrypt the PIT token for an agency. Returns None if not configured."""
    if not agency.ghl_pit_token_enc or not agency.ghl_location_id:
        return None
    try:
        return decrypt_secret(agency.ghl_pit_token_enc)
    except Exception:
        log.warning("Could not decrypt GHL PIT token for agency %s", agency.slug)
        return None


# ── Field auto-discovery ────────────────────────────────────────────────────
# GHL's /locations/{id}/customFields endpoint returns all custom fields for a
# location with their IDs.  We fuzzy-match field names so operators never need
# to manually copy-paste GHL field IDs.

_AGENT_NAME_VARIANTS = {
    "agent name", "agent", "agent_name", "assigned agent", "wa code", "wacode",
    "writing agent", "rep name", "representative",
}
_PREMIUM_VARIANTS = {
    "monthly premium", "monthly_premium", "annual premium", "annual_premium",
    "premium", "plan premium", "policy premium", "premium amount",
}
_PLAN_VARIANTS = {
    "plan name", "plan_name", "plan type", "plan", "product name", "product",
    "plan/product", "plan or product",
}
_STATE_VARIANTS = {
    "issue state", "issue_state", "state", "policy state", "client state",
}


def _fuzzy_match(name: str, variants: set[str]) -> bool:
    return name.lower().strip() in variants


async def discover_field_ids(pit_token: str, location_id: str) -> dict[str, str]:
    """Query GHL for all custom fields in a location and auto-map to our keys.

    Returns a partial field_map dict (only keys we could auto-match).
    Call this once per agency on first sync; results stored in agency.ghl_field_map.
    """
    hdrs = _headers(pit_token)
    result: dict[str, str] = {}

    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            resp = await _api_call_with_retry(
                client, "GET",
                f"{GHL_BASE}/locations/{location_id}/customFields",
                headers=hdrs,
            )
            if resp.status_code != 200:
                log.warning("GHL custom fields %s for location %s", resp.status_code, location_id)
                return result

            fields: list[dict] = resp.json().get("customFields") or []
            log.info("Discovered %d custom fields for location %s", len(fields), location_id)

            for f in fields:
                fid = f.get("id") or ""
                name = f.get("name") or f.get("fieldKey") or ""
                if not fid or not name:
                    continue
                if _fuzzy_match(name, _AGENT_NAME_VARIANTS):
                    result.setdefault("agent_name", fid)
                elif _fuzzy_match(name, _PREMIUM_VARIANTS):
                    result.setdefault("monthly_premium", fid)
                elif _fuzzy_match(name, _PLAN_VARIANTS):
                    result.setdefault("plan_name", fid)
                elif _fuzzy_match(name, _STATE_VARIANTS):
                    result.setdefault("issue_state_field", fid)

        except Exception as e:
            log.exception("Error discovering GHL fields for location %s: %s", location_id, e)

    return result
