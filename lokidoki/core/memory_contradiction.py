"""Belief revision: detect and resolve contradictions at write-time.

When a new fact arrives with the same (owner, subject_ref_id, predicate)
as an existing fact but a different value, we have a contradiction. For
single-value predicates (name, age, lives_in, ...) we treat the new
value as a belief revision: bump the loser's confidence down, then write
the new value. If the user explicitly negated the previous value
(``negates_previous=True`` from the decomposer), the loser is marked
``superseded`` immediately rather than left to decay.

Multi-value predicates (likes, visited, owns) coexist freely — both can
be true, no revision needed.

Returns a small report dict so the orchestrator can surface what
happened in the silent confirmation channel and clarification hints.
"""
from __future__ import annotations

import sqlite3
from typing import Optional

from lokidoki.core.confidence import (
    MIN_CONFIDENCE,
    is_single_value_predicate,
    update_confidence,
)


REJECT_THRESHOLD = 0.15


def detect_and_resolve_contradiction(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    subject: str,
    subject_ref_id: Optional[int],
    predicate: str,
    new_value: str,
    negates_previous: bool = False,
) -> dict:
    """Inspect existing facts for a contradiction with the incoming write.

    Returns ``{"action": str, "loser_id": int|None, "loser_value": str|None,
    "margin": float}`` where action is one of:
      - ``"none"``  — no contradiction (different value, multi-value predicate, or first time)
      - ``"revise"`` — single-value predicate, loser confidence bumped down
      - ``"supersede"`` — explicit negation, loser marked superseded
      - ``"reject_loser"`` — loser dropped below threshold and is now rejected
    """
    if not is_single_value_predicate(predicate) and not negates_previous:
        return {"action": "none", "loser_id": None, "loser_value": None, "margin": 0.0}

    # Find any existing ACTIVE fact for the same subject+predicate with a
    # different value. We restrict to active so previously superseded
    # rows don't get touched again.
    if subject_ref_id is not None:
        rows = conn.execute(
            "SELECT id, value, confidence FROM facts "
            "WHERE owner_user_id = ? AND subject_ref_id = ? AND predicate = ? "
            "AND value != ? AND status = 'active'",
            (user_id, subject_ref_id, predicate, new_value),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, value, confidence FROM facts "
            "WHERE owner_user_id = ? AND subject = ? AND predicate = ? "
            "AND value != ? AND status = 'active' AND subject_ref_id IS NULL",
            (user_id, subject, predicate, new_value),
        ).fetchall()

    if not rows:
        return {"action": "none", "loser_id": None, "loser_value": None, "margin": 0.0}

    # Pick the highest-confidence loser as the most relevant one to revise.
    loser = max(rows, key=lambda r: float(r["confidence"]))
    loser_id = int(loser["id"])
    loser_value = str(loser["value"])
    loser_conf = float(loser["confidence"])

    if negates_previous:
        # Explicit "no, it's X not Y" — mark every conflicting active row
        # as superseded so the new write becomes the sole truth. Stamp
        # valid_to=now so temporal queries can answer "what was true
        # before this correction?".
        conn.execute(
            "UPDATE facts SET status = 'superseded', "
            "valid_to = datetime('now'), updated_at = datetime('now') "
            "WHERE owner_user_id = ? AND id IN ({})".format(
                ",".join("?" * len(rows))
            ),
            (user_id, *(int(r["id"]) for r in rows)),
        )
        conn.commit()
        return {
            "action": "supersede",
            "loser_id": loser_id,
            "loser_value": loser_value,
            "margin": 1.0,
        }

    # Single-value predicate, no explicit negation: gently bump down.
    new_conf = update_confidence(loser_conf, confirmed=False, weight=0.35)
    new_status = "rejected" if new_conf <= REJECT_THRESHOLD else "active"
    conn.execute(
        "UPDATE facts SET confidence = ?, status = ?, updated_at = datetime('now') "
        "WHERE id = ?",
        (new_conf, new_status, loser_id),
    )
    conn.commit()
    return {
        "action": "reject_loser" if new_status == "rejected" else "revise",
        "loser_id": loser_id,
        "loser_value": loser_value,
        "margin": abs(new_conf - loser_conf),
    }
