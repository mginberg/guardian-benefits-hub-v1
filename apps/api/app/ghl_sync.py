"""
GHL sync service — upserts GHL contacts into leaderboard_contacts table.

Sync paths (newest-write-wins):
  1. Webhook   — instant on GHL ContactCreate event (POST /api/leaderboard/webhook/{slug})
  2. Cron      — every 30 min via worker APScheduler → sync_all_agencies()
  3. Manual    — super-admin POST /api/leaderboard/sync/{slug}

Incremental sync strategy (same as original app):
  - Every 3rd cron run does a FULL scan (all pages).
  - Other runs are INCREMENTAL: walk pages newest-first and stop after
    EARLY_EXIT_THRESHOLD consecutive contacts that are already identical in
    the DB (same agent, premium, date, state, plan). This bounds each run
    to O(new_deals) rather than O(total_contacts) during steady state.

Memory safety:
  - stream_qualified_contacts() yields one contact at a time (generator).
  - Each batch is discarded before the next GHL page is fetched.
  - Peak RAM = ~one GHL page (100 contacts) regardless of location size.
  - This is the fix for the original OOM crash on Guardian + Medigap.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ghl_client import SlimContact, discover_field_ids, get_field_map, get_pit_token, stream_qualified_contacts
from app.models import Agency, LeaderboardContact

log = logging.getLogger(__name__)

# After this many consecutive DB-matching contacts, stop incremental sync.
# (Full sync ignores this threshold.)
EARLY_EXIT_THRESHOLD = 200

# Commit to DB every N upserts to avoid holding a huge in-memory transaction.
BATCH_SIZE = 100

# Cron run counter — every 3rd run is a full sync.
_sync_counter: int = 0


# ── upsert helpers ──────────────────────────────────────────────────────────

def _contact_matches(row: LeaderboardContact, sc: SlimContact) -> bool:
    """Return True if the DB row already reflects the GHL contact exactly."""
    return (
        row.agent_name == sc.agent_name
        and abs(row.premium - sc.premium) < 0.01
        and row.issue_state == sc.issue_state
        and row.plan_name == sc.plan_name
    )


def _apply_slim(row: LeaderboardContact, sc: SlimContact) -> None:
    """Copy SlimContact fields onto an ORM row (in-place)."""
    row.agent_name = sc.agent_name
    row.premium = sc.premium
    row.issue_state = sc.issue_state
    row.plan_name = sc.plan_name
    row.contact_first_name = sc.contact_first_name
    row.contact_last_name = sc.contact_last_name
    if sc.date:
        row.ghl_date_added = sc.date if sc.date.tzinfo else sc.date.replace(tzinfo=timezone.utc)
    row.last_synced_at = datetime.now(timezone.utc)


def upsert_contact_from_slim(
    db: Session,
    *,
    agency: Agency,
    contact_id: str,
    sc: SlimContact,
    source: str = "ghl_sync",
) -> tuple[bool, bool]:
    """Upsert one LeaderboardContact. Returns (was_created, was_changed)."""
    existing = db.execute(
        select(LeaderboardContact).where(
            LeaderboardContact.ghl_location_id == agency.ghl_location_id,
            LeaderboardContact.ghl_contact_id == contact_id,
        )
    ).scalar_one_or_none()

    if existing:
        if _contact_matches(existing, sc):
            return False, False
        _apply_slim(existing, sc)
        existing.source = source
        return False, True

    date_added = None
    if sc.date:
        date_added = sc.date if sc.date.tzinfo else sc.date.replace(tzinfo=timezone.utc)

    row = LeaderboardContact(
        agency_id=agency.id,
        ghl_location_id=agency.ghl_location_id,
        ghl_contact_id=contact_id,
        source=source,
        agent_name=sc.agent_name,
        premium=sc.premium,
        plan_name=sc.plan_name,
        issue_state=sc.issue_state,
        contact_first_name=sc.contact_first_name,
        contact_last_name=sc.contact_last_name,
        ghl_date_added=date_added,
    )
    db.add(row)
    return True, True


def upsert_from_webhook_payload(
    db: Session,
    *,
    agency: Agency,
    payload: dict[str, Any],
) -> LeaderboardContact | None:
    """Called instantly when GHL fires a ContactCreate webhook.

    The webhook payload structure varies by GHL version.  We normalise it
    to find the contact object and extract the contact ID.
    """
    # Payload can be the contact directly, or wrapped in {"contact": {...}}
    contact = payload.get("contact") or payload.get("data") or payload
    contact_id = str(
        contact.get("id") or contact.get("contactId") or contact.get("contact_id") or ""
    ).strip()
    if not contact_id:
        log.warning("Webhook payload has no contact id for agency %s", agency.slug)
        return None

    fm = get_field_map(agency)
    from app.ghl_client import slim_contact as _slim
    sc = _slim(contact, fm)
    if sc is None:
        # Contact has no agent_name field — not a closed deal, ignore.
        log.debug("Webhook contact %s for agency %s has no agent_name — skipped", contact_id, agency.slug)
        return None

    upsert_contact_from_slim(db, agency=agency, contact_id=contact_id, sc=sc, source="webhook")
    db.commit()

    row = db.execute(
        select(LeaderboardContact).where(
            LeaderboardContact.ghl_location_id == agency.ghl_location_id,
            LeaderboardContact.ghl_contact_id == contact_id,
        )
    ).scalar_one_or_none()
    log.info("Webhook upserted contact %s for agency %s (agent=%s)", contact_id, agency.slug, sc.agent_name)
    return row


# ── per-agency sync ─────────────────────────────────────────────────────────

async def discover_and_save_fields(db: Session, agency: Agency) -> dict[str, Any]:
    """Fetch GHL custom fields for an agency and save discovered IDs to DB."""
    pit_token = get_pit_token(agency)
    if not pit_token:
        return {"error": "no_ghl_credentials"}

    discovered = await discover_field_ids(pit_token, agency.ghl_location_id)
    if not discovered:
        return {"error": "no_fields_found", "tip": "Check the PIT token has read access to the location"}

    import json
    existing: dict = {}
    try:
        existing = json.loads(agency.ghl_field_map or "{}")
    except Exception:
        pass

    merged = {**existing, **discovered}
    agency.ghl_field_map = json.dumps(merged)
    if "agent_name" in discovered:
        agency.ghl_agent_field_id = discovered["agent_name"]
    if "monthly_premium" in discovered:
        agency.ghl_premium_field_id = discovered["monthly_premium"]
    if "plan_name" in discovered:
        agency.ghl_plan_field_id = discovered["plan_name"]
    db.add(agency)
    db.commit()
    return {"discovered": discovered, "total_mapped": len(discovered)}


async def sync_agency(db: Session, agency: Agency, *, full: bool = False) -> dict[str, Any]:
    """Pull contacts from GHL and upsert into leaderboard_contacts.

    On first sync (or when field IDs are missing), auto-discovers the GHL
    custom field IDs from the location's field definitions — no manual config.
    """
    pit_token = get_pit_token(agency)
    if not pit_token:
        log.debug("Agency %s has no GHL credentials — skipping", agency.slug)
        return {"skipped": 1, "reason": "no_ghl_credentials"}

    # Auto-discover field IDs if not already configured
    existing_map: dict = {}
    try:
        import json
        existing_map = json.loads(agency.ghl_field_map or "{}")
    except Exception:
        pass

    needs_discovery = (
        not agency.ghl_agent_field_id
        and not existing_map.get("agent_name")
    )
    if needs_discovery:
        log.info("Agency %s: no field IDs configured — auto-discovering from GHL", agency.slug)
        discovered = await discover_field_ids(pit_token, agency.ghl_location_id)
        if discovered:
            import json
            merged = {**existing_map, **discovered}
            agency.ghl_field_map = json.dumps(merged)
            # Promote agent_name and monthly_premium to top-level columns too
            if "agent_name" in discovered:
                agency.ghl_agent_field_id = discovered["agent_name"]
            if "monthly_premium" in discovered:
                agency.ghl_premium_field_id = discovered["monthly_premium"]
            if "plan_name" in discovered:
                agency.ghl_plan_field_id = discovered["plan_name"]
            db.add(agency)
            db.commit()
            log.info("Agency %s: auto-discovered field IDs: %s", agency.slug, discovered)

    field_map = get_field_map(agency)
    created = updated = skipped = 0
    consecutive_unchanged = 0
    partial_failure = False
    batch_count = 0

    try:
        async for contact_id, sc in stream_qualified_contacts(
            pit_token, agency.ghl_location_id, field_map
        ):
            was_created, was_changed = upsert_contact_from_slim(
                db, agency=agency, contact_id=contact_id, sc=sc
            )

            if was_created:
                created += 1
                consecutive_unchanged = 0
            elif was_changed:
                updated += 1
                consecutive_unchanged = 0
            else:
                skipped += 1
                consecutive_unchanged += 1

            batch_count += 1
            if batch_count >= BATCH_SIZE:
                db.commit()
                batch_count = 0

            # Incremental early exit: stop when we see a long run of unchanged rows
            if not full and consecutive_unchanged >= EARLY_EXIT_THRESHOLD:
                log.info(
                    "Agency %s: incremental early exit after %d unchanged rows",
                    agency.slug, consecutive_unchanged,
                )
                break

        if batch_count > 0:
            db.commit()

    except Exception as exc:
        # Preserve any partial progress committed so far
        try:
            db.commit()
        except Exception:
            db.rollback()
        partial_failure = True
        log.exception("GHL sync failed for agency %s (created=%d, updated=%d): %s", agency.slug, created, updated, exc)

    result: dict[str, Any] = {
        "created": created,
        "updated": updated,
        "skipped": skipped,
    }
    if partial_failure:
        result["partial_failure"] = True
    log.info(
        "GHL sync done for agency %s: created=%d updated=%d skipped=%d%s",
        agency.slug, created, updated, skipped, " (PARTIAL)" if partial_failure else "",
    )
    return result


# ── sync all agencies ───────────────────────────────────────────────────────

async def sync_all_agencies(db: Session) -> dict[str, Any]:
    """Called by the worker cron every 5 minutes.

    Every 6th call (≈30 min) is a full scan; otherwise incremental (early-exit
    on already-seen contacts). Deduplicates by location_id so shared sub-accounts
    aren't scanned twice.
    """
    global _sync_counter
    _sync_counter += 1
    full = (_sync_counter % 6) == 0

    if full:
        log.info("GHL sync-all: FULL scan (run %d)", _sync_counter)
    else:
        log.info("GHL sync-all: incremental (run %d)", _sync_counter)

    agencies = db.execute(
        select(Agency).where(
            Agency.is_active == True,  # noqa: E712
        )
    ).scalars().all()

    # Deduplicate by location_id — same GHL sub-account shared by multiple
    # Agency rows should only be synced once per run.
    seen_locations: set[str] = set()
    results: dict[str, Any] = {}

    for agency in agencies:
        if not agency.ghl_location_id or not agency.ghl_pit_token_enc:
            continue
        if agency.ghl_location_id in seen_locations:
            log.debug("Agency %s shares location %s — skipping duplicate sync", agency.slug, agency.ghl_location_id)
            continue
        seen_locations.add(agency.ghl_location_id)
        results[agency.slug] = await sync_agency(db, agency, full=full)

    return {"run": _sync_counter, "full": full, "agencies": results}
