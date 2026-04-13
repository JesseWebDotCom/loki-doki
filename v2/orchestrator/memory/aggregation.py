"""Nightly aggregation job for Tier 7 procedural memory (M5).

Walks ``behavior_events`` since the last run, updates
``user_profile.style`` (7a, prompt-safe) and ``user_profile.telemetry``
(7b, prompt-forbidden), then drops folded events older than 30 days.

The aggregation is **deterministic** — no LLM. It counts event types,
averages response lengths, and maps observed patterns to closed-enum
style descriptors.

Usage::

    from v2.orchestrator.memory.aggregation import run_aggregation
    run_aggregation(store, owner_user_id)

The caller decides scheduling (cron, app startup, etc.).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any

from v2.orchestrator.memory.store import V2MemoryStore

log = logging.getLogger("v2.orchestrator.memory.aggregation")

# Events older than this are dropped after folding into the profile.
EVENT_RETENTION_DAYS: int = 30

# Minimum events before style derivation is attempted.
MIN_EVENTS_FOR_DERIVATION: int = 5


def run_aggregation(
    store: V2MemoryStore,
    owner_user_id: int,
) -> dict[str, Any]:
    """Run the full aggregation cycle. Returns a summary dict.

    Steps:
    1. Read events since the last aggregation timestamp.
    2. Derive style descriptors from event patterns.
    3. Update telemetry counters.
    4. Write updated profile.
    5. Drop events older than EVENT_RETENTION_DAYS.
    """
    profile = store.get_user_profile(owner_user_id)
    last_run = profile["telemetry"].get("last_aggregation")

    events = store.get_behavior_events(
        owner_user_id,
        since=last_run,
        limit=2000,
    )
    if not events:
        return {"events_processed": 0, "style_updated": False}

    # Parse payloads
    parsed_events = []
    for ev in events:
        payload_raw = ev.get("payload")
        payload = {}
        if payload_raw:
            try:
                payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
            except (TypeError, ValueError):
                pass
        parsed_events.append({
            "event_type": ev.get("event_type", ""),
            "at": ev.get("at", ""),
            "payload": payload if isinstance(payload, dict) else {},
        })

    # Derive style (7a)
    style = profile["style"].copy()
    if len(parsed_events) >= MIN_EVENTS_FOR_DERIVATION:
        style = _derive_style(parsed_events, style)

    # Update telemetry (7b)
    telemetry = profile["telemetry"].copy()
    telemetry = _update_telemetry(parsed_events, telemetry)
    telemetry["last_aggregation"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"

    # Write profile
    store.set_user_style(owner_user_id, style)
    store.set_user_telemetry(owner_user_id, telemetry)

    # Drop old events
    cutoff = (datetime.utcnow() - timedelta(days=EVENT_RETENTION_DAYS)).isoformat(timespec="seconds") + "Z"
    deleted = store.delete_behavior_events_before(owner_user_id, before=cutoff)

    return {
        "events_processed": len(parsed_events),
        "style_updated": len(parsed_events) >= MIN_EVENTS_FOR_DERIVATION,
        "events_deleted": deleted,
        "style": style,
    }


def _derive_style(
    events: list[dict[str, Any]],
    current_style: dict[str, Any],
) -> dict[str, Any]:
    """Derive Tier 7a style descriptors from event patterns.

    Each descriptor uses a simple majority-vote or threshold rule
    over the event payloads. The closed enum values are chosen to
    be interpretable by the synthesizer without explanation.
    """
    style = current_style.copy()

    # Verbosity: average response length
    lengths = [
        ev["payload"].get("response_length", 0)
        for ev in events
        if ev["payload"].get("response_length") is not None
    ]
    if lengths:
        avg_len = sum(lengths) / len(lengths)
        if avg_len < 80:
            style["verbosity"] = "concise"
        elif avg_len > 300:
            style["verbosity"] = "detailed"
        else:
            style["verbosity"] = "moderate"

    # Preferred modality: majority vote
    modalities = [
        ev["payload"].get("modality", "text")
        for ev in events
        if ev["payload"].get("modality")
    ]
    if modalities:
        counts: dict[str, int] = {}
        for m in modalities:
            counts[m] = counts.get(m, 0) + 1
        style["preferred_modality"] = max(counts, key=counts.get)  # type: ignore[arg-type]

    # Routine time buckets: which hours the user is active
    hours: list[int] = []
    for ev in events:
        at = ev.get("at", "")
        if len(at) >= 13:
            try:
                h = int(at[11:13])
                hours.append(h)
            except (ValueError, IndexError):
                pass
    if hours:
        morning = sum(1 for h in hours if 5 <= h < 12)
        afternoon = sum(1 for h in hours if 12 <= h < 17)
        evening = sum(1 for h in hours if 17 <= h < 22)
        night = sum(1 for h in hours if h >= 22 or h < 5)
        buckets = {
            "morning": morning, "afternoon": afternoon,
            "evening": evening, "night": night,
        }
        dominant = max(buckets, key=buckets.get)  # type: ignore[arg-type]
        if buckets[dominant] > len(hours) * 0.4:
            style["routine_time_bucket"] = dominant

    return style


def _update_telemetry(
    events: list[dict[str, Any]],
    current_telemetry: dict[str, Any],
) -> dict[str, Any]:
    """Update Tier 7b telemetry counters from events."""
    telemetry = current_telemetry.copy()

    total_turns = telemetry.get("total_turns", 0) + len(events)
    telemetry["total_turns"] = total_turns

    successes = sum(
        1 for ev in events
        if ev["payload"].get("success", True)
    )
    telemetry["total_successes"] = telemetry.get("total_successes", 0) + successes
    telemetry["total_failures"] = telemetry.get("total_failures", 0) + (len(events) - successes)

    # Capability usage histogram
    cap_hist: dict[str, int] = telemetry.get("capability_histogram", {})
    if not isinstance(cap_hist, dict):
        cap_hist = {}
    for ev in events:
        for cap in ev["payload"].get("capabilities", []):
            if cap:
                cap_hist[cap] = cap_hist.get(cap, 0) + 1
    telemetry["capability_histogram"] = cap_hist

    return telemetry
