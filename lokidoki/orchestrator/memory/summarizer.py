"""Session-close episodic summarizer (M4).

Queues an out-of-band summarization job on session close, producing one
``episodes`` row per close. Deterministic + template-driven (M4 gate);
small-model variant is a follow-up bake-off.

Topic scope uses deterministic entity clustering (§10 Q9). Cross-session
promotion lives in :mod:`lokidoki.orchestrator.memory.promotion`.
"""
from __future__ import annotations

import logging
import threading
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

from lokidoki.orchestrator.memory.store import MemoryStore, _now

log = logging.getLogger("lokidoki.orchestrator.memory.summarizer")


@dataclass
class SessionObservation:
    """One memory-write observation captured during the session.

    The summarizer gets a list of these from the pipeline's session
    bookkeeping (or from a test that constructs them directly).
    """

    subject: str
    predicate: str
    value: str
    source_text: str = ""
    sentiment: str | None = None
    entities: tuple[str, ...] = field(default_factory=tuple)


@dataclass
class SummarizationResult:
    """What the summarizer produced for one session-close."""

    episode_id: int
    title: str
    summary: str
    topic_scope: str | None
    promoted_claims: list[dict[str, Any]] = field(default_factory=list)


def derive_topic_scope(
    observations: Iterable[SessionObservation],
    *,
    explicit: str | None = None,
) -> str | None:
    """Pick a topic_scope tag for the session.

    Strategy (M4 deterministic clustering, per §10 Q9):

        1. If the caller passed an explicit ``topic_scope`` use it.
        2. Otherwise, count entity strings across all observations.
           If any entity appears in ≥ 2 observations AND is the
           single most-frequent entity, return its slugified form.
        3. Otherwise return None — the episode is untagged and the
           reader's general FTS path handles it.
    """
    if explicit:
        return explicit
    counter: Counter[str] = Counter()
    for obs in observations:
        for ent in obs.entities:
            if ent:
                counter[ent.strip().lower()] += 1
    if not counter:
        return None
    # Need at least 2 mentions for the entity to count as a "topic".
    most_common = counter.most_common(2)
    top_label, top_count = most_common[0]
    if top_count < 2:
        return None
    if len(most_common) > 1 and most_common[1][1] == top_count:
        # Tie at the top → no clear topic scope.
        return None
    return _slugify(top_label)


def _slugify(label: str) -> str:
    """Cheap slugifier — lowercased, spaces and punctuation become underscores."""
    out = []
    for ch in label.lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in {" ", "-", "_"} and (not out or out[-1] != "_"):
            out.append("_")
    slug = "".join(out).strip("_")
    return slug or "topic"


def _build_title(observations: list[SessionObservation], topic_scope: str | None) -> str:
    if topic_scope:
        return f"Session about {topic_scope.replace('_', ' ')}"
    if not observations:
        return "Conversation"
    return f"Conversation about {observations[0].predicate.replace('_', ' ')}"


def _build_summary(
    observations: list[SessionObservation],
    *,
    started_at: str,
) -> str:
    """Deterministic template-fill summary.

    No LLM. The line shape is structured enough that the M4 reader's
    BM25 + temporal-proximity scoring picks up the right episodes for
    queries that mention any of the bullet contents.
    """
    if not observations:
        return f"On {started_at}: short conversation with no captured facts."
    bullets: list[str] = []
    for obs in observations[:8]:
        bullet = f"{obs.subject} {obs.predicate}={obs.value}"
        if obs.source_text:
            bullet += f" ({obs.source_text})"
        bullets.append(bullet)
    return f"On {started_at}: " + "; ".join(bullets)


def summarize_session(
    store: MemoryStore,
    *,
    session_id: int,
    owner_user_id: int,
    observations: list[SessionObservation] | None = None,
    explicit_topic_scope: str | None = None,
) -> SummarizationResult:
    """Run the summarizer for a single session-close.

    Returns the new episode id + the cross-session promotion result.
    Always closes the session (stamps ``ended_at``) so a re-run is a
    no-op for the same session id.
    """
    obs = list(observations or [])
    topic_scope = derive_topic_scope(obs, explicit=explicit_topic_scope)
    title = _build_title(obs, topic_scope)
    summary = _build_summary(obs, started_at=_now())

    episode_id = _write_episode_row(
        store=store,
        owner_user_id=owner_user_id,
        session_id=session_id,
        obs=obs,
        title=title,
        summary=summary,
        topic_scope=topic_scope,
    )
    store.close_session(session_id)

    promoted = _run_promotion(store=store, owner_user_id=owner_user_id, obs=obs)

    return SummarizationResult(
        episode_id=episode_id,
        title=title,
        summary=summary,
        topic_scope=topic_scope,
        promoted_claims=promoted,
    )


def _write_episode_row(
    *,
    store: MemoryStore,
    owner_user_id: int,
    session_id: int,
    obs: list[SessionObservation],
    title: str,
    summary: str,
    topic_scope: str | None,
) -> int:
    """Serialize observations and write one episodes row; return its id."""
    entity_payload = [
        {
            "subject": o.subject,
            "predicate": o.predicate,
            "value": o.value,
            "source_text": o.source_text,
        }
        for o in obs
    ]
    sentiment = next((o.sentiment for o in obs if o.sentiment), None)
    return store.write_episode(
        owner_user_id=owner_user_id,
        title=title,
        summary=summary,
        entities=entity_payload,
        sentiment=sentiment,
        topic_scope=topic_scope,
        session_id=session_id,
    )


def _run_promotion(
    *,
    store: MemoryStore,
    owner_user_id: int,
    obs: list[SessionObservation],
) -> list[dict[str, Any]]:
    """Run cross-session promotion after a session closes."""
    from lokidoki.orchestrator.memory.promotion import run_cross_session_promotion

    return run_cross_session_promotion(
        store=store,
        owner_user_id=owner_user_id,
        observations=obs,
    )


# ---------------------------------------------------------------------------
# Out-of-band queue
# ---------------------------------------------------------------------------

# The pipeline calls ``queue_session_close`` after the synchronous turn
# returns. The actual work runs on a small thread pool so the closing
# turn's user-visible latency is unaffected. Tests run the queue
# synchronously via ``run_pending_summaries`` to keep the test suite
# hermetic.

_QUEUE_LOCK = threading.RLock()
_PENDING_JOBS: list[dict[str, Any]] = []


def queue_session_close(
    *,
    store: MemoryStore,
    session_id: int,
    owner_user_id: int,
    observations: list[SessionObservation],
    explicit_topic_scope: str | None = None,
) -> None:
    """Queue a session-close summarization for later execution.

    The pipeline calls this from its session-close hook. The job runs
    on the next ``run_pending_summaries`` call (or on a background
    thread if one is started). The hot loop never blocks on this.
    """
    with _QUEUE_LOCK:
        _PENDING_JOBS.append(
            {
                "store": store,
                "session_id": session_id,
                "owner_user_id": owner_user_id,
                "observations": list(observations),
                "explicit_topic_scope": explicit_topic_scope,
                "queued_at": _now(),
            }
        )


def run_pending_summaries() -> list[SummarizationResult]:
    """Drain the queue and run every pending summarization synchronously.

    Returns the results in queue order. Used by tests and by an
    optional background thread to flush pending work.
    """
    with _QUEUE_LOCK:
        jobs = list(_PENDING_JOBS)
        _PENDING_JOBS.clear()
    results: list[SummarizationResult] = []
    for job in jobs:
        try:
            result = summarize_session(
                job["store"],
                session_id=job["session_id"],
                owner_user_id=job["owner_user_id"],
                observations=job["observations"],
                explicit_topic_scope=job.get("explicit_topic_scope"),
            )
            results.append(result)
        except Exception as exc:  # noqa: BLE001 — never crash the queue
            log.warning("session summarization failed: %s", exc)
    return results


def pending_job_count() -> int:
    """Return the number of pending session-close jobs (used by tests)."""
    with _QUEUE_LOCK:
        return len(_PENDING_JOBS)


def reset_queue() -> None:
    """Clear any pending jobs. Tests use this to keep state hermetic."""
    with _QUEUE_LOCK:
        _PENDING_JOBS.clear()
