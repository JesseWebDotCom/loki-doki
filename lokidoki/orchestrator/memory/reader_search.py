"""Low-level search sources for memory retrieval (BM25, vector, subject scan)."""
from __future__ import annotations

import json
import logging
import math
import re
from typing import Iterable, Sequence

from lokidoki.orchestrator.memory.store import MemoryStore

log = logging.getLogger("lokidoki.orchestrator.memory.reader")

RRF_K: int = 60
VECTOR_SIM_FLOOR: float = 0.15

_TOKEN_RE = re.compile(r"[A-Za-z0-9']+")
_STOPWORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "i", "me", "my", "you", "your", "of", "to", "in", "on", "at", "for",
    "with", "and", "or", "but", "do", "does", "did", "what", "who",
    "where", "when", "why", "how",
})


def _clean_query_terms(query: str) -> list[str]:
    """Split `query` into FTS5-safe content tokens, dropping stopwords."""
    if not query:
        return []
    tokens = [m.group(0).lower() for m in _TOKEN_RE.finditer(query)]
    return [t for t in tokens if t and t not in _STOPWORDS]


def _build_fts_match(terms: Sequence[str]) -> str:
    """Build an FTS5 MATCH expression that ORs the terms together."""
    if not terms:
        return ""
    return " OR ".join(f'"{t}"' for t in terms)


def _bm25_search(
    store: MemoryStore,
    owner_user_id: int,
    terms: Sequence[str],
    *,
    limit: int = 20,
) -> list[tuple[int, float]]:
    """Run an FTS5 BM25 search over the value + source_text columns."""
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
    except Exception as exc:  # noqa: BLE001
        log.warning("memory reader BM25 failed: %s", exc)
        return []
    return [(int(row["fact_id"]), float(row["score"])) for row in rows]


def _embed_query(query: str) -> list[float] | None:
    """Compute the query embedding using the same backend as the store."""
    if not query or not query.strip():
        return None
    try:
        from lokidoki.orchestrator.routing.embeddings import get_embedding_backend
    except Exception as exc:  # noqa: BLE001
        log.debug("memory reader: embedding backend unavailable: %s", exc)
        return None
    try:
        backend = get_embedding_backend()
        vectors = backend.embed([query])
    except Exception as exc:  # noqa: BLE001
        log.debug("memory reader: embedding query failed: %s", exc)
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


def _vector_search(
    store: MemoryStore,
    owner_user_id: int,
    query: str,
    *,
    limit: int = 20,
) -> list[tuple[int, float]]:
    """Cosine-similarity scan over the embedding column (LIMIT 500 safety cap)."""
    query_vec = _embed_query(query)
    if query_vec is None:
        return []
    try:
        rows = store._conn.execute(
            "SELECT id, embedding FROM facts "
            "WHERE owner_user_id = ? AND status = 'active' "
            "AND embedding IS NOT NULL LIMIT 500",
            (owner_user_id,),
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        log.warning("memory reader vector scan failed: %s", exc)
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
    store: MemoryStore,
    owner_user_id: int,
    terms: Sequence[str],
    *,
    limit: int = 20,
) -> list[tuple[int, float]]:
    """Subject-scan companion source for RRF (LIMIT 200 safety cap)."""
    if not terms:
        return []
    try:
        rows = store._conn.execute(
            "SELECT id, subject FROM facts "
            "WHERE owner_user_id = ? AND status = 'active' LIMIT 200",
            (owner_user_id,),
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        log.warning("memory reader subject scan failed: %s", exc)
        return []
    matches: list[tuple[int, float]] = []
    lowered_terms = [t.lower() for t in terms]
    for row in rows:
        subject_lower = str(row["subject"]).lower()
        normalised = (
            subject_lower.replace("person:", "")
            .replace("handle:", "").replace("entity:", "")
        )
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
    """Reciprocal Rank Fusion over multiple ranked sources."""
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
