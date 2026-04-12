"""
Triggered in-session consolidation (v1.2 fast-path).

When a candidate (a) is *not* on the immediate-durable list and (b) lands in
Tier 3 (episodic) for the third time within a single session OR within a
24-hour rolling window, the orchestrator fires an immediate consolidation
attempt that runs the same logic as the nightly reflect job's promotion step.

Triggered consolidation is *eligibility*, not *bypass* — the candidate must
still pass Layers 1 and 2.

Phase status: M4 — real in-session frequency counter backed by
``sessions.session_state``. The counter persists to the session_state JSON
so the rolling window survives session boundaries within the same day.

See `docs/MEMORY_DESIGN.md` §3 Layer 3 (Triggered consolidation).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from v2.orchestrator.memory.store import V2MemoryStore

log = logging.getLogger("v2.orchestrator.memory.consolidation")

# Threshold for triggered consolidation. Tunable; v1.2 set this to 3 to
# match the cross-session promotion threshold. Tune in M4 against the recall
# corpus per `docs/MEMORY_DESIGN.md` §10 question 11.
TRIGGERED_CONSOLIDATION_THRESHOLD: int = 3

# Rolling window for cross-session consolidation within the same day.
ROLLING_WINDOW_HOURS: int = 24


@dataclass(frozen=True)
class ConsolidationResult:
    triggered: bool
    observation_count: int
    reason: str


def maybe_trigger_consolidation(
    *,
    store: "V2MemoryStore",
    session_id: int,
    owner_user_id: int,
    subject: str,
    predicate: str,
    value: str,
) -> ConsolidationResult:
    """Check and bump the in-session frequency counter for a (subject, predicate) pair.

    When the count reaches ``TRIGGERED_CONSOLIDATION_THRESHOLD``, runs the
    candidate through the writer to create/upgrade a durable Tier 4 row.

    The 24h rolling window resets the counter if the ``first_at`` timestamp
    is older than ``ROLLING_WINDOW_HOURS`` hours ago.
    """
    key = f"{owner_user_id}:{subject}:{predicate}"
    state = store.get_session_state(session_id)
    counters = state.get("consolidation") or {}
    if not isinstance(counters, dict):
        counters = {}

    now_str = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    entry = counters.get(key) or {
        "count": 0,
        "first_at": now_str,
        "last_at": now_str,
    }
    if not isinstance(entry, dict):
        entry = {"count": 0, "first_at": now_str, "last_at": now_str}

    # 24h rolling window: reset if the first observation for this key
    # is older than ROLLING_WINDOW_HOURS.
    first_at_str = str(entry.get("first_at", now_str))
    try:
        first_at = datetime.fromisoformat(first_at_str.rstrip("Z"))
        now_dt = datetime.utcnow()
        if (now_dt - first_at) > timedelta(hours=ROLLING_WINDOW_HOURS):
            entry = {"count": 0, "first_at": now_str, "last_at": now_str}
    except (ValueError, TypeError):
        entry = {"count": 0, "first_at": now_str, "last_at": now_str}

    entry["count"] = int(entry.get("count", 0)) + 1
    entry["last_at"] = now_str
    counters[key] = entry
    state["consolidation"] = counters
    store.set_session_state(session_id, state)

    count = int(entry["count"])
    if count < TRIGGERED_CONSOLIDATION_THRESHOLD:
        return ConsolidationResult(
            triggered=False,
            observation_count=count,
            reason=f"below_threshold ({count}/{TRIGGERED_CONSOLIDATION_THRESHOLD})",
        )

    # Threshold reached — run the candidate through the writer to
    # create/upgrade a durable Tier 4 row. The writer's gate chain
    # still applies so all structural guarantees hold.
    from v2.orchestrator.memory.candidate import MemoryCandidate
    from v2.orchestrator.memory.writer import process_candidate

    candidate = MemoryCandidate(
        subject=subject,
        predicate=predicate,
        value=value,
        owner_user_id=owner_user_id,
        source_text=f"consolidated via {count} in-session observations",
    )
    decision = process_candidate(candidate, store=store)
    if decision.accepted:
        log.info(
            "triggered consolidation: %s/%s=%s promoted after %d observations",
            subject,
            predicate,
            value,
            count,
        )
        return ConsolidationResult(
            triggered=True,
            observation_count=count,
            reason=f"promoted_at_{count}",
        )

    return ConsolidationResult(
        triggered=False,
        observation_count=count,
        reason=f"threshold_met_but_gate_rejected ({decision.reason})",
    )
