from __future__ import annotations

from datetime import date, datetime
from typing import Optional


CONTRACT_REASON_LABELS: dict[str, str] = {
    "WI": "Withdrawn",
    "LP": "Lapsed",
    "DE": "Declined",
    "CA": "Canceled",
    "DC": "Claim",
    "IC": "Incomplete",
    "RS": "Reinstated/Restored",
    "OW": "Owner Withdrawn",
    "RI": "Ready to Issue",
    "NT": "Not Taken",
    "CV": "Converted",
    "AC": "Canceled",
    "HO": "Suspended (Pending - NSF)",
    "SR": "Surrendered",
    "RE": "Reinstated",
    "SM": "Submitted",
    "PC": "Policy Change",
}

BAD_REASON_OVERRIDES: dict[str, str] = {
    "LP": "cancelled",
    "CA": "cancelled",
    "IC": "non_effectuated",
    "RS": "cancelled",
    "OW": "cancelled",
    "NT": "non_effectuated",
    "DE": "cancelled",
    "AC": "cancelled",
}

NON_EFFECTUATION_CONFIRMING_CODES = frozenset({"LP", "IC", "NT", "CA", "AC", "OW", "RS", "DE"})


def parse_date(raw: str | None) -> Optional[date]:
    if not raw:
        return None
    val = str(raw).strip()
    if not val or val in ("0", "00000000", "0000-00-00"):
        return None
    for fmt in ("%Y%m%d", "%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%m/%d/%y", "%m-%d-%y"):
        try:
            return datetime.strptime(val, fmt).date()
        except ValueError:
            continue
    return None


def classify_policy(policy: dict, *, today: Optional[date] = None) -> tuple[str, str]:
    today = today or date.today()

    cntrct = str(policy.get("cntrct_code", "") or "").strip().upper()
    reason = str(policy.get("cntrct_reason", "") or "").strip().upper()
    billing_raw = str(policy.get("billing_mode", "") or "").strip()
    try:
        billing = int(billing_raw) if billing_raw else 0
    except (TypeError, ValueError):
        billing = 0

    issue = policy.get("issue_date")
    paid_to = policy.get("paid_to_date")

    ever_paid = bool(issue and paid_to and paid_to > issue)

    def enrich(msg: str) -> str:
        if reason:
            label = CONTRACT_REASON_LABELS.get(reason, reason)
            return f"{msg} — Reason: {reason} ({label})"
        return msg

    if cntrct == "S" or (reason == "HO" and cntrct in ("A", "P")):
        return ("suspended", enrich("Billing suspended"))

    if cntrct == "P":
        return ("pending_new", enrich("Pending — submitted, not yet issued"))

    if cntrct == "T":
        if ever_paid:
            return ("terminated", enrich("Cancelled after effectuation"))
        return ("non_effectuated", enrich("Terminated — never made first payment"))

    if cntrct == "A":
        if issue and issue > today:
            return ("future_effective", enrich("Future effective date"))

        if billing == 3 and not ever_paid and reason in NON_EFFECTUATION_CONFIRMING_CODES:
            return ("non_effectuated", enrich("First draft failed — switched to quarterly, never paid"))

        if ever_paid:
            if paid_to and paid_to >= today:
                cls = "active"
                msg = "Active"
            else:
                cls = "lapsed"
                msg = "Lapsed — past due"
        else:
            if issue and (today - issue).days >= 30:
                return ("pending_cancel", enrich("Pending 30+ days — likely non-effectuation"))
            return ("pending_payment", enrich("Awaiting first payment"))

        if cls == "active" and reason in BAD_REASON_OVERRIDES:
            override = BAD_REASON_OVERRIDES[reason]
            return (override, enrich(f"Overridden from active → {override}"))

        return (cls, enrich(msg))

    return ("unknown", enrich(f"Unknown contract code '{cntrct}'"))

