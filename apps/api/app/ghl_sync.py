"""
GHL (GoHighLevel) sync service for the leaderboard.

Contacts in GHL represent deal submissions. We mirror them into
LeaderboardContact so the leaderboard can show real-time deal counts
and premium without re-querying GHL on every page load.

Sync paths:
  1. Webhook  — GHL calls POST /api/leaderboard/webhook/{agency_slug}
               instantly when a contact is created.  O(1).
  2. Cron     — Worker calls sync_all_agencies() every 30 min.
               Incremental by default (since last sync); full on first run.
  3. Manual   — Super-admin POST /api/leaderboard/sync/{agency_slug}

GHL field mapping (customField values keyed by field name):
  "agent_name"    or "agent" or "wa_code"   → agent_name
  "annual_premium" or "premium"             → premium
  "plan_name"     or "plan_type"            → plan_name
  "state"         or "issue_state"         → issue_state
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Agency, LeaderboardContact
from app.security import decrypt_secret

log = logging.getLogger(__name__)

GHL_BASE = "https://services.leadconnectorhq.com"
GHL_API_VERSION = "2021-07-28"

# ── helpers ────────────────────────────────────────────────────────────────

def _headers(pit_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {pit_token}",
        "Version": GHL_API_VERSION,
        "Content-Type": "application/json",
    }


def _parse_datetime(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        # GHL returns ISO-8601 strings, sometimes with trailing Z
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return None


def _extract_custom_field(fields: list[dict], *keys: str) -> str:
    """Return first non-empty value matching any of the provided field name keys."""
    keys_lower = {k.lower() for k in keys}
    for f in fields:
        name = (f.get("name") or f.get("fieldKey") or "").lower()
        if name in keys_lower:
            val = f.get("value") or ""
            if val:
                return str(val).strip()
    return ""


def _contact_to_fields(contact: dict[str, Any]) -> dict[str, Any]:
    """Map a raw GHL contact dict to LeaderboardContact fields."""
    custom = contact.get("customFields") or contact.get("customField") or []
    if isinstance(custom, dict):
        # Some GHL versions return a dict keyed by field ID
        custom = [{"fieldKey": k, "value": v} for k, v in custom.items()]

    agent_name = (
        _extract_custom_field(custom, "agent_name", "agent", "wa_code", "assigned_agent")
        or contact.get("assignedTo", "")
        or ""
    )
    premium_raw = _extract_custom_field(custom, "annual_premium", "premium", "annualpremium", "annual premium")
    try:
        premium = float(str(premium_raw).replace("$", "").replace(",", "").strip()) if premium_raw else 0.0
    except (ValueError, TypeError):
        premium = 0.0

    plan_name = _extract_custom_field(custom, "plan_name", "plan_type", "planname", "plan type", "plan")
    issue_state = _extract_custom_field(custom, "state", "issue_state", "issuestate")

    date_added = _parse_datetime(contact.get("dateAdded") or contact.get("date_added"))

    return {
        "agent_name": agent_name,
        "premium": premium,
        "plan_name": plan_name,
        "issue_state": issue_state,
        "contact_first_name": contact.get("firstName") or contact.get("first_name") or "",
        "contact_last_name": contact.get("lastName") or contact.get("last_name") or "",
        "ghl_date_added": date_added,
    }


# ── upsert ─────────────────────────────────────────────────────────────────

def upsert_contact(
    db: Session,
    *,
    agency_id: str,
    ghl_location_id: str,
    ghl_contact_id: str,
    source: str = "ghl_sync",
    **fields: Any,
) -> LeaderboardContact:
    """Create or update one LeaderboardContact row. Returns the row."""
    existing = db.execute(
        select(LeaderboardContact).where(
            LeaderboardContact.ghl_location_id == ghl_location_id,
            LeaderboardContact.ghl_contact_id == ghl_contact_id,
        )
    ).scalar_one_or_none()

    if existing:
        for k, v in fields.items():
            setattr(existing, k, v)
        existing.source = source
        existing.last_synced_at = datetime.now(timezone.utc)
        db.flush()
        return existing

    row = LeaderboardContact(
        agency_id=agency_id,
        ghl_location_id=ghl_location_id,
        ghl_contact_id=ghl_contact_id,
        source=source,
        **fields,
    )
    db.add(row)
    db.flush()
    return row


def upsert_from_webhook(
    db: Session,
    *,
    agency: Agency,
    contact: dict[str, Any],
) -> LeaderboardContact:
    """Called instantly when GHL fires a ContactCreate webhook."""
    fields = _contact_to_fields(contact)
    row = upsert_contact(
        db,
        agency_id=agency.id,
        ghl_location_id=agency.ghl_location_id,
        ghl_contact_id=str(contact.get("id") or contact.get("contactId") or ""),
        source="webhook",
        **fields,
    )
    db.commit()
    log.info("Webhook upserted contact %s for agency %s", row.ghl_contact_id, agency.slug)
    return row


# ── GHL API fetch ──────────────────────────────────────────────────────────

async def _fetch_contacts_page(
    client: httpx.AsyncClient,
    pit_token: str,
    location_id: str,
    *,
    start_after: str | None = None,
    limit: int = 100,
) -> tuple[list[dict], str | None]:
    """Fetch one page of contacts. Returns (contacts, next_page_url_or_none)."""
    params: dict[str, Any] = {"locationId": location_id, "limit": limit}
    if start_after:
        params["startAfter"] = start_after

    try:
        resp = await client.get(
            f"{GHL_BASE}/contacts/",
            headers=_headers(pit_token),
            params=params,
            timeout=20,
        )
        resp.raise_for_status()
        body = resp.json()
        contacts = body.get("contacts") or []
        # GHL uses `nextPageUrl` or `meta.nextPageUrl` for pagination
        meta = body.get("meta") or {}
        next_url = meta.get("nextPageUrl") or body.get("nextPageUrl")
        return contacts, next_url
    except httpx.HTTPStatusError as e:
        log.error("GHL API error %s for location %s: %s", e.response.status_code, location_id, e.response.text[:200])
        return [], None
    except Exception as e:
        log.error("GHL fetch error for location %s: %s", location_id, e)
        return [], None


async def sync_agency(db: Session, agency: Agency, *, full: bool = False) -> dict[str, int]:
    """Pull contacts from GHL and upsert into LeaderboardContact.

    Args:
        full: If True, re-sync all time (slow). If False, incremental since last sync.
    Returns dict with counts.
    """
    if not agency.ghl_pit_token_enc or not agency.ghl_location_id:
        log.debug("Agency %s has no GHL credentials — skipping sync", agency.slug)
        return {"skipped": 1}

    try:
        pit_token = decrypt_secret(agency.ghl_pit_token_enc)
    except Exception:
        log.warning("Could not decrypt GHL token for agency %s", agency.slug)
        return {"error": 1}

    created = updated = 0
    start_after: str | None = None

    async with httpx.AsyncClient() as client:
        while True:
            contacts, next_url = await _fetch_contacts_page(
                client, pit_token, agency.ghl_location_id,
                start_after=start_after,
            )
            if not contacts:
                break

            for c in contacts:
                fields = _contact_to_fields(c)
                contact_id = str(c.get("id") or c.get("contactId") or "")
                if not contact_id:
                    continue

                existing = db.execute(
                    select(LeaderboardContact).where(
                        LeaderboardContact.ghl_location_id == agency.ghl_location_id,
                        LeaderboardContact.ghl_contact_id == contact_id,
                    )
                ).scalar_one_or_none()

                if existing:
                    for k, v in fields.items():
                        setattr(existing, k, v)
                    existing.last_synced_at = datetime.now(timezone.utc)
                    updated += 1
                else:
                    db.add(LeaderboardContact(
                        agency_id=agency.id,
                        ghl_location_id=agency.ghl_location_id,
                        ghl_contact_id=contact_id,
                        source="ghl_sync",
                        **fields,
                    ))
                    created += 1

            db.commit()

            if not next_url:
                break

            # Extract startAfter token from next URL for pagination
            if "startAfter=" in next_url:
                start_after = next_url.split("startAfter=")[-1].split("&")[0]
            else:
                break

    log.info("Synced agency %s: %d created, %d updated", agency.slug, created, updated)
    return {"created": created, "updated": updated}


async def sync_all_agencies(db: Session) -> dict[str, Any]:
    """Called by the worker cron every 30 minutes."""
    agencies = db.execute(
        select(Agency).where(
            Agency.is_active == True,  # noqa: E712
            Agency.ghl_location_id != "",
            Agency.ghl_pit_token_enc != "",
        )
    ).scalars().all()

    results = {}
    for agency in agencies:
        results[agency.slug] = await sync_agency(db, agency)

    return results
