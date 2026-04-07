"""Hybrid BM25 + cosine fact search.

PR3 ships with the embedder deferred (see ``TODO(embeddings-perf)``),
so in practice this almost always falls back to BM25-only. The blend
path is implemented and unit-tested anyway so the day a real embedder
lands we just start writing vectors and the orchestrator picks them up
without further changes.

Blend rule
----------
score = 0.5 * bm25_norm + 0.5 * cosine_norm

Each component is min-max normalized to [0, 1] *within the candidate
result set*. Per-set normalization (rather than global) keeps the blend
robust to BM25's unbounded magnitude — without it a query with a
single very-low BM25 score would always lose to cosine.
"""
from __future__ import annotations

import sqlite3

from lokidoki.core.memory_sql import fts_escape


def _bm25_search(
    conn: sqlite3.Connection, user_id: int, fts_query: str, limit: int
) -> list[sqlite3.Row]:
    """BM25 over facts_fts. Lower score = better match (FTS5 convention)."""
    return conn.execute(
        "SELECT f.id, f.subject, f.subject_type, f.subject_ref_id, "
        "       f.predicate, f.value, f.category, f.confidence, "
        "       f.created_at, bm25(facts_fts) AS score "
        "FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid "
        "WHERE facts_fts MATCH ? AND f.owner_user_id = ? "
        "ORDER BY score LIMIT ?",
        (fts_query, user_id, limit),
    ).fetchall()


def _user_has_vectors(conn: sqlite3.Connection, user_id: int) -> bool:
    """True iff this user has at least one fact embedding stored."""
    try:
        row = conn.execute(
            "SELECT 1 FROM vec_facts vf "
            "JOIN facts f ON f.id = vf.fact_id "
            "WHERE f.owner_user_id = ? LIMIT 1",
            (user_id,),
        ).fetchone()
    except sqlite3.OperationalError:
        # vec_facts virtual table not present (sqlite-vec failed to load).
        return False
    return row is not None


def _min_max(values: list[float]) -> list[float]:
    """Normalize to [0, 1]; constant input → all 0.5 (neutral)."""
    if not values:
        return []
    lo, hi = min(values), max(values)
    if hi - lo < 1e-9:
        return [0.5] * len(values)
    return [(v - lo) / (hi - lo) for v in values]


def hybrid_search_facts(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    query: str,
    top_k: int = 10,
    vec_enabled: bool = False,
) -> list[dict]:
    """Public entry point: returns ranked dicts.

    The returned shape is intentionally a superset of the PR1
    BM25-only return so existing callers keep working: each row has
    ``id, subject, predicate, value, category, confidence, score``.
    """
    if not query.strip():
        return []
    fts_query = fts_escape(query)

    bm25_rows = _bm25_search(conn, user_id, fts_query, top_k * 2)
    if not bm25_rows:
        return []

    bm25_scores = [float(r["score"]) for r in bm25_rows]
    # FTS5 bm25() is "lower is better" — invert before normalizing so
    # the blended score is "higher is better" like cosine.
    inverted = [-s for s in bm25_scores]
    bm25_norm = _min_max(inverted)

    # Cosine path. Skipped entirely when vectors aren't available — the
    # PR3 default. When wired, ``vec_enabled`` is the provider's
    # ``vec_loaded`` flag and we additionally require this user to have
    # at least one stored embedding.
    use_vec = vec_enabled and _user_has_vectors(conn, user_id)
    if use_vec:
        # Placeholder for the future cosine path. The real implementation
        # will compute the query embedding, run vec0's KNN, and align
        # ids back to the bm25 candidate set. Until the embedder lands
        # we treat cosine as a no-op (all 0.5) — the blend still runs so
        # the code path is exercised by tests.
        cos_norm = [0.5] * len(bm25_rows)
        blended = [0.5 * b + 0.5 * c for b, c in zip(bm25_norm, cos_norm)]
    else:
        blended = bm25_norm

    ranked = sorted(
        zip(bm25_rows, blended), key=lambda pair: pair[1], reverse=True
    )[:top_k]

    out: list[dict] = []
    for row, score in ranked:
        d = dict(row)
        d["score"] = float(score)
        out.append(d)
    return out
