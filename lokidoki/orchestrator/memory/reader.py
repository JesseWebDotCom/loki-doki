"""
Tier 4 read path — FTS5 + RRF retrieval for the memory store.

This is the read side of M2. It is **deliberately not a port** of v1's
``lokidoki.core.memory_search`` — that module relies on substring
heuristics (``_query_mentions`` / ``_is_explicitly_relevant`` from
[memory_phase2.py:49](../../../lokidoki/core/memory_phase2.py#L49)) and
the design explicitly forbids substring-matching retrieval. This
file therefore implements the BM25 + (optional vector) hybrid from
scratch over the store's own SQLite tables.

Phase status: M2 — FTS5 BM25 over `facts_fts` plus a complementary
subject-prefix scan, fused via Reciprocal Rank Fusion. Embedding-based
similarity is wired behind a feature flag so the same module can pick
up sqlite-vec when it's available without restructuring callers. The
default `read_user_facts` path is BM25 + subject-scan only, which keeps
the read path hermetic and dependency-free.

Public surface:

    read_user_facts(store, owner_user_id, query, *, top_k=3) -> list[FactHit]
    score_facts_rrf(per_source_results, k=60) -> list[FactHit]
    read_social_context(store, owner_user_id, query, *, top_k=3) -> list[PersonHit]
    resolve_person(store, owner_user_id, mention) -> PersonResolution
    read_episodes(store, owner_user_id, query, *, top_k=2) -> list[EpisodeHit]
    read_recent_context(store, session_id) -> SessionContext

The reader honors lazy retrieval: callers (the pipeline) only invoke
it when ``need_preference`` is set, so a "hi" turn never touches the
store.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from lokidoki.orchestrator.memory.reader_search import (
    RRF_K,
    _bm25_search,
    _build_fts_match,
    _clean_query_terms,
    _subject_scan,
    _vector_search,
    score_facts_rrf,
)
from lokidoki.orchestrator.memory.store import MemoryStore

log = logging.getLogger("lokidoki.orchestrator.memory.reader")


# ---------------------------------------------------------------------------
# Dataclasses — kept here so every sub-module can import them without cycles
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FactHit:
    """A single retrieved fact, with the per-source rank info preserved."""

    fact_id: int
    owner_user_id: int
    subject: str
    predicate: str
    value: str
    confidence: float
    score: float
    sources: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class PersonHit:
    """A single retrieved Tier 5 person row with attached relationships."""

    person_id: int
    owner_user_id: int
    name: str | None
    handle: str | None
    provisional: bool
    relations: tuple[str, ...]
    score: float
    matched_via: str  # "name" | "handle" | "alias_fuzzy" | "recency"


@dataclass(frozen=True)
class PersonResolution:
    """Outcome of resolving a single mention against the store.

    ``ambiguous`` is True when more than one record tied for the top
    score; the resolver does NOT pick a winner in that case — Gate 2
    of the writer rejects ambiguous resolutions per design §3.
    """

    matched: PersonHit | None
    ambiguous: bool
    candidates: tuple[PersonHit, ...]
    reason: str


@dataclass(frozen=True)
class SessionContext:
    """The recent-context payload for the ``{recent_context}`` slot."""

    session_id: int
    last_seen: dict[str, dict[str, str]]
    """Keyed by ``last_<type>`` → ``{name, at}``."""


# ---------------------------------------------------------------------------
# Tier 4 read (M2)
# ---------------------------------------------------------------------------


def read_user_facts(
    store: MemoryStore,
    owner_user_id: int,
    query: str,
    *,
    top_k: int = 3,
    predicate_filter: Iterable[str] | None = None,
) -> list[FactHit]:
    """Lazy Tier 4 read path: only call this when need_preference is set.

    Runs BM25 + subject-scan in parallel (logically; SQLite is
    single-process so they're sequential), fuses via RRF, and returns
    the top-k hits with stable ordering. ``predicate_filter`` lets the
    caller restrict to a closed predicate set when the call site has
    structural information about what kind of fact it wants.
    """
    terms = _clean_query_terms(query)
    if not terms:
        # Empty query -> fall back to "all active facts for this user
        # by recency". This handles bare-context calls like "what do
        # you know about me" cleanly without inventing keywords.
        rows = store._conn.execute(
            """
            SELECT id, owner_user_id, subject, predicate, value, confidence
            FROM facts
            WHERE owner_user_id = ? AND status = 'active'
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (owner_user_id, top_k),
        ).fetchall()
        return [
            FactHit(
                fact_id=int(row["id"]),
                owner_user_id=int(row["owner_user_id"]),
                subject=str(row["subject"]),
                predicate=str(row["predicate"]),
                value=str(row["value"]),
                confidence=float(row["confidence"]),
                score=1.0,
                sources=("recency",),
            )
            for row in rows
        ]

    bm25_hits = _bm25_search(store, owner_user_id, terms, limit=20)
    subject_hits = _subject_scan(store, owner_user_id, terms, limit=20)
    vector_hits = _vector_search(store, owner_user_id, query, limit=20)
    fused = score_facts_rrf(
        [
            ("bm25", bm25_hits),
            ("subject", subject_hits),
            ("vector", vector_hits),
        ]
    )
    if not fused:
        return []

    # Hydrate the fused fact ids with row data and apply optional
    # predicate filter.
    fact_ids = list(fused.keys())
    placeholders = ",".join("?" * len(fact_ids))
    sql = f"""
        SELECT id, owner_user_id, subject, predicate, value, confidence
        FROM facts
        WHERE id IN ({placeholders})
          AND owner_user_id = ?
          AND status = 'active'
    """
    params: list[object] = list(fact_ids) + [owner_user_id]
    rows = store._conn.execute(sql, params).fetchall()

    predicate_set: set[str] | None = (
        set(predicate_filter) if predicate_filter is not None else None
    )
    hits: list[FactHit] = []
    for row in rows:
        if predicate_set is not None and row["predicate"] not in predicate_set:
            continue
        score, sources = fused[int(row["id"])]
        hits.append(
            FactHit(
                fact_id=int(row["id"]),
                owner_user_id=int(row["owner_user_id"]),
                subject=str(row["subject"]),
                predicate=str(row["predicate"]),
                value=str(row["value"]),
                confidence=float(row["confidence"]),
                score=score,
                sources=tuple(sources),
            )
        )
    hits.sort(key=lambda h: (-h.score, -h.confidence, h.fact_id))
    return hits[:top_k]


# ---------------------------------------------------------------------------
# Tier 2 (session) read path — M4
# ---------------------------------------------------------------------------


def read_recent_context(
    store: MemoryStore,
    session_id: int,
) -> SessionContext:
    """Return the Tier 2 last-seen map + unresolved questions for a session.

    This is the read side of ``update_last_seen``. The pronoun resolver
    consults it when it detects an unresolved reference.
    """
    state = store.get_session_state(session_id)
    last_seen = state.get("last_seen") or {}
    if not isinstance(last_seen, dict):
        last_seen = {}
    return SessionContext(
        session_id=session_id,
        last_seen=last_seen,
    )


# ---------------------------------------------------------------------------
# Re-exports from sub-modules — keeps `from reader import X` stable
# ---------------------------------------------------------------------------

from lokidoki.orchestrator.memory.reader_episodes import EpisodeHit, read_episodes  # noqa: E402
from lokidoki.orchestrator.memory.reader_search import (  # noqa: E402
    VECTOR_SIM_FLOOR,
    _embed_query,
)
from lokidoki.orchestrator.memory.reader_social import (  # noqa: E402
    read_social_context,
    resolve_person,
)

__all__ = [
    "EpisodeHit",
    "FactHit",
    "PersonHit",
    "PersonResolution",
    "RRF_K",
    "SessionContext",
    "VECTOR_SIM_FLOOR",
    "read_episodes",
    "read_recent_context",
    "read_social_context",
    "read_user_facts",
    "resolve_person",
    "score_facts_rrf",
]
