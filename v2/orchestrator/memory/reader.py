"""
Tier 4 read path — FTS5 + RRF retrieval for the v2 memory store.

This is the read side of M2. It is **deliberately not a port** of v1's
``lokidoki.core.memory_search`` — that module relies on substring
heuristics (``_query_mentions`` / ``_is_explicitly_relevant`` from
[memory_phase2.py:49](../../../lokidoki/core/memory_phase2.py#L49)) and
the v2 design explicitly forbids substring-matching retrieval. This
file therefore implements the BM25 + (optional vector) hybrid from
scratch over the v2 store's own SQLite tables.

Phase status: M2 — FTS5 BM25 over `facts_fts` plus a complementary
subject-prefix scan, fused via Reciprocal Rank Fusion. Embedding-based
similarity is wired behind a feature flag so the same module can pick
up sqlite-vec when it's available without restructuring callers. The
default `read_user_facts` path is BM25 + subject-scan only, which keeps
the read path hermetic and dependency-free.

Public surface:

    read_user_facts(store, owner_user_id, query, *, top_k=3) -> list[FactHit]
    score_facts_rrf(per_source_results, k=60) -> list[FactHit]

The reader honors lazy retrieval: callers (the pipeline) only invoke
it when ``need_preference`` is set, so a "hi" turn never touches the
store.
"""
from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from v2.orchestrator.memory.store import V2MemoryStore

log = logging.getLogger("v2.orchestrator.memory.reader")

# Reciprocal Rank Fusion damping constant. The Hindsight paper and the
# original Cormack et al. RRF paper both default to k=60. We follow that.
RRF_K: int = 60

# Small token cleaner used to build FTS5 MATCH queries safely. We strip
# everything that isn't word-shaped so the query can never inject FTS5
# operators (NEAR, OR, NOT, double-quotes, etc.).
_TOKEN_RE = re.compile(r"[A-Za-z0-9']+")
_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "i",
        "me",
        "my",
        "you",
        "your",
        "of",
        "to",
        "in",
        "on",
        "at",
        "for",
        "with",
        "and",
        "or",
        "but",
        "do",
        "does",
        "did",
        "what",
        "who",
        "where",
        "when",
        "why",
        "how",
    }
)


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
    """Outcome of resolving a single mention against the v2 store.

    ``ambiguous`` is True when more than one record tied for the top
    score; the resolver does NOT pick a winner in that case — Gate 2
    of the writer rejects ambiguous resolutions per design §3.
    """

    matched: PersonHit | None
    ambiguous: bool
    candidates: tuple[PersonHit, ...]
    reason: str


def _clean_query_terms(query: str) -> list[str]:
    """Split `query` into FTS5-safe content tokens, dropping stopwords."""
    if not query:
        return []
    tokens = [m.group(0).lower() for m in _TOKEN_RE.finditer(query)]
    return [t for t in tokens if t and t not in _STOPWORDS]


def _build_fts_match(terms: Sequence[str]) -> str:
    """Build an FTS5 MATCH expression that ORs the terms together.

    We OR rather than AND because the design requires recall-leaning
    retrieval: a query about "favorite color" should still hit a fact
    about "color preferences" even if "favorite" isn't tokenized in
    the stored value. The reranker (RRF) then picks the best hit.
    """
    if not terms:
        return ""
    quoted = [f'"{t}"' for t in terms]
    return " OR ".join(quoted)


def _bm25_search(
    store: V2MemoryStore,
    owner_user_id: int,
    terms: Sequence[str],
    *,
    limit: int = 20,
) -> list[tuple[int, float]]:
    """Run an FTS5 BM25 search over the value + source_text columns.

    Returns a list of (fact_id, bm25_score) ordered by BM25 ascending —
    FTS5's bm25() returns a smaller-is-better score, which we keep as-is
    so RRF normalisation handles the direction.
    """
    if not terms:
        return []
    match = _build_fts_match(terms)
    sql = """
        SELECT facts_fts.rowid AS fact_id, bm25(facts_fts) AS score
        FROM facts_fts
        JOIN facts ON facts.id = facts_fts.rowid
        WHERE facts_fts MATCH ?
          AND facts.owner_user_id = ?
          AND facts.status = 'active'
        ORDER BY score
        LIMIT ?
    """
    try:
        rows = store._conn.execute(sql, (match, owner_user_id, limit)).fetchall()
    except Exception as exc:  # noqa: BLE001 — FTS5 query syntax / locked DB
        log.warning("v2 memory reader BM25 failed: %s", exc)
        return []
    return [(int(row["fact_id"]), float(row["score"])) for row in rows]


def _embed_query(query: str) -> list[float] | None:
    """Compute the query embedding using the same backend as the store.

    Returns None when the embedding backend isn't available — callers
    treat this as "skip the vector source" rather than crash.
    """
    if not query or not query.strip():
        return None
    try:
        from v2.orchestrator.routing.embeddings import get_embedding_backend
    except Exception as exc:  # noqa: BLE001
        log.debug("v2 memory reader: embedding backend unavailable: %s", exc)
        return None
    try:
        backend = get_embedding_backend()
        vectors = backend.embed([query])
    except Exception as exc:  # noqa: BLE001
        log.debug("v2 memory reader: embedding query failed: %s", exc)
        return None
    if not vectors or not vectors[0]:
        return None
    return list(vectors[0])


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for av, bv in zip(a, b):
        dot += av * bv
        norm_a += av * av
        norm_b += bv * bv
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (math.sqrt(norm_a) * math.sqrt(norm_b))


# Cosine similarity floor — vectors below this are dropped from the
# vector source. Tuned conservatively because the hash fallback embedding
# backend produces noisier vectors than fastembed.
VECTOR_SIM_FLOOR: float = 0.15


def _vector_search(
    store: V2MemoryStore,
    owner_user_id: int,
    query: str,
    *,
    limit: int = 20,
) -> list[tuple[int, float]]:
    """Cosine-similarity scan over the embedding column.

    Returns a list of (fact_id, similarity) ordered by similarity
    descending. Returns [] when the embedding backend isn't available
    or when no row clears VECTOR_SIM_FLOOR.

    This is the third source for RRF fusion in :func:`read_user_facts`,
    sitting alongside BM25 and the structured subject scan.
    """
    query_vec = _embed_query(query)
    if query_vec is None:
        return []
    try:
        rows = store._conn.execute(
            "SELECT id, embedding FROM facts "
            "WHERE owner_user_id = ? AND status = 'active' "
            "AND embedding IS NOT NULL",
            (owner_user_id,),
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        log.warning("v2 memory reader vector scan failed: %s", exc)
        return []
    scored: list[tuple[int, float]] = []
    for row in rows:
        try:
            row_vec = json.loads(row["embedding"] or "[]")
        except (TypeError, ValueError):
            continue
        sim = _cosine(query_vec, row_vec)
        if sim >= VECTOR_SIM_FLOOR:
            scored.append((int(row["id"]), float(sim)))
    scored.sort(key=lambda pair: -pair[1])
    return scored[:limit]


def _subject_scan(
    store: V2MemoryStore,
    owner_user_id: int,
    terms: Sequence[str],
    *,
    limit: int = 20,
) -> list[tuple[int, float]]:
    """Subject-scan companion source for RRF.

    Looks for facts whose subject string contains any of the cleaned
    query terms — useful for queries like "what is Luke's birthday"
    where the subject is `person:Luke` and we want all rows for Luke
    even if the value text doesn't echo the term. This is **not** a
    substring-matching heuristic over the user input — it's a
    deterministic scan over the *stored subject column*, which is the
    extractor's structured output.
    """
    if not terms:
        return []
    sql = """
        SELECT id, subject FROM facts
        WHERE owner_user_id = ? AND status = 'active'
    """
    try:
        rows = store._conn.execute(sql, (owner_user_id,)).fetchall()
    except Exception as exc:  # noqa: BLE001
        log.warning("v2 memory reader subject scan failed: %s", exc)
        return []
    matches: list[tuple[int, float]] = []
    lowered_terms = [t.lower() for t in terms]
    for row in rows:
        subject_lower = str(row["subject"]).lower()
        # Score = number of terms that appear in the subject. Subject
        # tokens like "person:luke" are normalised before comparison so
        # the prefix doesn't dominate.
        normalised = subject_lower.replace("person:", "").replace("handle:", "").replace("entity:", "")
        hit_count = sum(1 for t in lowered_terms if t in normalised)
        if hit_count > 0:
            matches.append((int(row["id"]), float(hit_count)))
    matches.sort(key=lambda pair: -pair[1])
    return matches[:limit]


def score_facts_rrf(
    per_source_results: Iterable[tuple[str, list[tuple[int, float]]]],
    *,
    k: int = RRF_K,
) -> dict[int, tuple[float, list[str]]]:
    """Reciprocal Rank Fusion over multiple ranked sources.

    Each source contributes ``1 / (k + rank)`` to a fact's score, where
    rank is 1-indexed. Returns a dict ``{fact_id: (score, sources)}``.
    """
    fused: dict[int, tuple[float, list[str]]] = {}
    for source_name, ranked in per_source_results:
        for rank_index, (fact_id, _raw_score) in enumerate(ranked, start=1):
            contribution = 1.0 / (k + rank_index)
            current = fused.get(fact_id)
            if current is None:
                fused[fact_id] = (contribution, [source_name])
            else:
                fused[fact_id] = (current[0] + contribution, current[1] + [source_name])
    return fused


# ---------------------------------------------------------------------------
# Tier 5 (social) read path — M3
# ---------------------------------------------------------------------------


def _person_relations(store: V2MemoryStore, person_id: int) -> tuple[str, ...]:
    rows = store._conn.execute(
        "SELECT relation_label FROM relationships WHERE person_id = ? ORDER BY id",
        (person_id,),
    ).fetchall()
    return tuple(str(row["relation_label"]) for row in rows)


def _row_to_person_hit(
    store: V2MemoryStore,
    row,
    *,
    score: float,
    matched_via: str,
) -> PersonHit:
    return PersonHit(
        person_id=int(row["id"]),
        owner_user_id=int(row["owner_user_id"]),
        name=row["name"] if row["name"] is not None else None,
        handle=row["handle"] if row["handle"] is not None else None,
        provisional=bool(row["provisional"]),
        relations=_person_relations(store, int(row["id"])),
        score=score,
        matched_via=matched_via,
    )


def resolve_person(
    store: V2MemoryStore,
    owner_user_id: int,
    mention: str,
) -> PersonResolution:
    """Resolve a mention to a Tier 5 person row.

    The resolver applies a deterministic four-strategy ladder per
    design §10 question 1's "deterministic ruleset is the safer
    default" decision:

        1. Exact name match (case-insensitive). If exactly one row
           wins, return it.
        2. Handle match (for provisional handles). If the mention
           starts with "my " or matches an existing handle exactly.
        3. Substring on name (≥3 chars). The substring is matched
           against the **canonical name column**, not against user
           input — the user's mention is the structured argument to
           this function, not free-form text being classified.
        4. Optional rapidfuzz fallback (≥80) when rapidfuzz is
           installed. Falls through silently when not.

    Ties at any strategy mark the resolution as ambiguous and Gate 2
    of the writer rejects ambiguous candidates per design §3 Gate 2.
    """
    if not mention or not mention.strip():
        return PersonResolution(None, False, (), "empty_mention")
    needle = mention.strip().lower()

    # Strategy 1: exact name match
    name_rows = store._conn.execute(
        "SELECT id, owner_user_id, name, handle, provisional "
        "FROM people WHERE owner_user_id = ? AND LOWER(name) = ?",
        (owner_user_id, needle),
    ).fetchall()
    if name_rows:
        hits = tuple(
            _row_to_person_hit(store, row, score=1.0, matched_via="name")
            for row in name_rows
        )
        if len(hits) > 1:
            return PersonResolution(None, True, hits, "ambiguous_name")
        return PersonResolution(hits[0], False, hits, "exact_name")

    # Strategy 2: handle match (provisional handles)
    handle_rows = store._conn.execute(
        "SELECT id, owner_user_id, name, handle, provisional "
        "FROM people WHERE owner_user_id = ? AND LOWER(handle) = ?",
        (owner_user_id, needle),
    ).fetchall()
    if handle_rows:
        hits = tuple(
            _row_to_person_hit(store, row, score=0.95, matched_via="handle")
            for row in handle_rows
        )
        if len(hits) > 1:
            return PersonResolution(None, True, hits, "ambiguous_handle")
        return PersonResolution(hits[0], False, hits, "exact_handle")

    # Strategy 3: substring against canonical name (≥3 chars).
    if len(needle) >= 3:
        substring_rows = store._conn.execute(
            "SELECT id, owner_user_id, name, handle, provisional "
            "FROM people WHERE owner_user_id = ? "
            "AND name IS NOT NULL AND LOWER(name) LIKE ?",
            (owner_user_id, f"%{needle}%"),
        ).fetchall()
        if substring_rows:
            hits = tuple(
                _row_to_person_hit(store, row, score=0.7, matched_via="name_substring")
                for row in substring_rows
            )
            if len(hits) > 1:
                return PersonResolution(None, True, hits, "ambiguous_substring")
            return PersonResolution(hits[0], False, hits, "substring_name")

    # Strategy 4: optional rapidfuzz fallback
    try:
        from rapidfuzz import fuzz
    except ImportError:
        fuzz = None
    if fuzz is not None:
        all_rows = store._conn.execute(
            "SELECT id, owner_user_id, name, handle, provisional "
            "FROM people WHERE owner_user_id = ? AND name IS NOT NULL",
            (owner_user_id,),
        ).fetchall()
        scored: list[tuple[int, object]] = []
        for row in all_rows:
            score = int(fuzz.ratio(needle, str(row["name"]).lower()))
            if score >= 80:
                scored.append((score, row))
        if scored:
            scored.sort(key=lambda pair: -pair[0])
            top_score = scored[0][0]
            top = [row for s, row in scored if s == top_score]
            hits = tuple(
                _row_to_person_hit(store, row, score=top_score / 100.0, matched_via="alias_fuzzy")
                for row in top
            )
            if len(hits) > 1:
                return PersonResolution(None, True, hits, "ambiguous_fuzzy")
            return PersonResolution(hits[0], False, hits, "fuzzy_name")

    return PersonResolution(None, False, (), "no_match")


def read_social_context(
    store: V2MemoryStore,
    owner_user_id: int,
    query: str,
    *,
    top_k: int = 3,
) -> list[PersonHit]:
    """Tier 5 read path — return the most relevant people for a query.

    M3 strategy: try to resolve the cleaned query terms one at a time
    against the people table; collect any hits; deduplicate by person_id;
    fall back to the most-recently-updated people for the owner if
    nothing matched. The result is a small set of PersonHits suitable
    for rendering into the {social_context} prompt slot.
    """
    seen: dict[int, PersonHit] = {}

    terms = _clean_query_terms(query) if query else []
    for term in terms:
        result = resolve_person(store, owner_user_id, term)
        if result.matched is not None:
            seen.setdefault(result.matched.person_id, result.matched)
        elif result.candidates:
            for cand in result.candidates:
                seen.setdefault(cand.person_id, cand)

    # If we don't have enough hits, top up with recent people.
    if len(seen) < top_k:
        rows = store._conn.execute(
            "SELECT id, owner_user_id, name, handle, provisional "
            "FROM people WHERE owner_user_id = ? "
            "ORDER BY updated_at DESC, id DESC LIMIT ?",
            (owner_user_id, top_k),
        ).fetchall()
        for row in rows:
            person_id = int(row["id"])
            if person_id in seen:
                continue
            seen[person_id] = _row_to_person_hit(store, row, score=0.5, matched_via="recency")
            if len(seen) >= top_k:
                break

    hits = sorted(
        seen.values(),
        key=lambda h: (-h.score, h.person_id),
    )
    return hits[:top_k]


# ---------------------------------------------------------------------------
# Tier 4 read (M2)
# ---------------------------------------------------------------------------


def read_user_facts(
    store: V2MemoryStore,
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
        # Empty query → fall back to "all active facts for this user
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
    # M2.5 third source — embedding cosine similarity. The query
    # passed to the vector source is the *raw query string*, not the
    # cleaned terms, so vocabulary mismatches like "what do I eat" ->
    # "dietary restriction vegetarian" can be bridged via semantic
    # similarity even when no token overlaps.
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
    # predicate filter. We pull all matched ids in one IN-query rather
    # than N round-trips.
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
