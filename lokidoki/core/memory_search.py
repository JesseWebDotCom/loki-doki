"""Hybrid BM25 + cosine fact search.

The embedder ships in lokidoki/core/embedder.py and writes 384-dim
bge-small-en-v1.5 vectors into ``vec_facts`` on every fact insert. This
module fuses BM25 (lexical) with cosine (semantic) so neither modality
dominates.

Blend rule — Reciprocal Rank Fusion
-----------------------------------
RRF beats min-max-normalized score blending in every public benchmark
because it's invariant to score-magnitude differences across modalities.
For each candidate, the fused score is:

    rrf_score = sum over modalities of  1 / (k + rank_in_modality)

with k = 60 (the standard constant from the original RRF paper). A
fact in the top-3 of BM25 and not in cosine still ranks; a fact in
the top-3 of cosine and not in BM25 also ranks; a fact in the top-3
of both ranks higher. No score normalization needed.
"""
from __future__ import annotations

import sqlite3
from typing import Optional, Union, List, Dict

from lokidoki.core.memory_sql import fts_escape


def _bm25_search(
    conn: sqlite3.Connection, user_id: int, fts_query: str, limit: int, project_id: Optional[int] = None
) -> List[sqlite3.Row]:
    """BM25 over facts_fts. Lower score = better match (FTS5 convention)."""
    if project_id is not None:
        return conn.execute(
            "SELECT f.id, f.subject, f.subject_type, f.subject_ref_id, "
            "       f.predicate, f.value, f.category, f.confidence, "
            "       f.created_at, bm25(facts_fts) * (CASE WHEN f.project_id = ? THEN 0.5 ELSE 1.0 END) AS score "
            "FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid "
            "WHERE facts_fts MATCH ? AND f.owner_user_id = ? "
            "ORDER BY score LIMIT ?",
            (project_id, fts_query, user_id, limit),
        ).fetchall()
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


RRF_K = 60  # standard constant from the original RRF paper


def _vec_search(
    conn: sqlite3.Connection,
    user_id: int,
    query_vec: list[float],
    limit: int,
    project_id: Optional[int],
) -> List[sqlite3.Row]:
    """KNN over vec_facts. Lower distance = better match.

    sqlite-vec exposes a ``vec0`` virtual table that supports a
    ``MATCH ?`` clause with a JSON-encoded query vector and a
    ``k=?`` constraint. We join back to ``facts`` to enforce
    user-scoping and to fetch the same columns BM25 returns, so the
    fusion step downstream can treat both result sets as one shape.
    """
    import json as _json
    qjson = _json.dumps(query_vec)
    try:
        if project_id is not None:
            return conn.execute(
                "SELECT f.id, f.subject, f.subject_type, f.subject_ref_id, "
                "       f.predicate, f.value, f.category, f.confidence, "
                "       f.created_at, vf.distance AS score "
                "FROM vec_facts vf JOIN facts f ON f.id = vf.fact_id "
                "WHERE vf.embedding MATCH ? AND k = ? "
                "AND f.owner_user_id = ? AND f.project_id = ? "
                "AND f.status IN ('active','ambiguous') "
                "ORDER BY vf.distance",
                (qjson, limit, user_id, project_id),
            ).fetchall()
        return conn.execute(
            "SELECT f.id, f.subject, f.subject_type, f.subject_ref_id, "
            "       f.predicate, f.value, f.category, f.confidence, "
            "       f.created_at, vf.distance AS score "
            "FROM vec_facts vf JOIN facts f ON f.id = vf.fact_id "
            "WHERE vf.embedding MATCH ? AND k = ? "
            "AND f.owner_user_id = ? "
            "AND f.status IN ('active','ambiguous') "
            "ORDER BY vf.distance",
            (qjson, limit, user_id),
        ).fetchall()
    except sqlite3.OperationalError:
        return []


def _rrf_fuse(
    bm25_rows: List[sqlite3.Row],
    vec_rows: List[sqlite3.Row],
    top_k: int,
) -> list[tuple[sqlite3.Row, float]]:
    """Reciprocal Rank Fusion of two ranked lists.

    Each row's contribution is ``1 / (RRF_K + rank)`` where rank is
    its 1-indexed position within its source list. A row appearing in
    both lists sums both contributions. Returns the top_k by fused
    score with the canonical row reference (preferring BM25's row
    object when present so existing column access patterns work).
    """
    scores: dict[int, float] = {}
    rows_by_id: dict[int, sqlite3.Row] = {}

    for rank, row in enumerate(bm25_rows, start=1):
        fid = int(row["id"])
        scores[fid] = scores.get(fid, 0.0) + 1.0 / (RRF_K + rank)
        rows_by_id[fid] = row

    for rank, row in enumerate(vec_rows, start=1):
        fid = int(row["id"])
        scores[fid] = scores.get(fid, 0.0) + 1.0 / (RRF_K + rank)
        # Only fall back to vec's row object when BM25 didn't have one.
        rows_by_id.setdefault(fid, row)

    ranked_ids = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
    return [(rows_by_id[fid], score) for fid, score in ranked_ids]


def hybrid_search_facts(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    query: str,
    top_k: int = 10,
    vec_enabled: bool = False,
    project_id: Optional[int] = None,
) -> list[dict]:
    """Public entry point: returns ranked dicts.

    Runs BM25 and (if available) vector KNN in parallel, then fuses
    via Reciprocal Rank Fusion. Falls back to BM25-only when vectors
    aren't available — the BM25-only return shape is preserved so
    every existing caller keeps working unchanged.
    """
    if not query.strip():
        return []
    fts_query = fts_escape(query)

    # Pull twice as many candidates from each modality as the caller
    # asked for so the fusion has room to surface cross-modality wins.
    candidate_k = max(top_k * 2, 10)
    bm25_rows = _bm25_search(conn, user_id, fts_query, candidate_k, project_id=project_id)

    use_vec = vec_enabled and _user_has_vectors(conn, user_id)
    vec_rows: List[sqlite3.Row] = []
    if use_vec:
        try:
            from lokidoki.core.embedder import get_embedder
            qvec = get_embedder().embed_query(query)
            vec_rows = _vec_search(conn, user_id, qvec, candidate_k, project_id)
        except Exception:  # noqa: BLE001 — degrade to BM25-only
            vec_rows = []

    if not bm25_rows and not vec_rows:
        return []

    # If only one modality returned anything, skip RRF and rank by that
    # modality's score directly. RRF on a single list reduces to its
    # original ranking anyway, but this avoids the dict overhead.
    if not vec_rows:
        ranked = [(r, -float(r["score"])) for r in bm25_rows[:top_k]]
    elif not bm25_rows:
        ranked = [(r, -float(r["score"])) for r in vec_rows[:top_k]]
    else:
        ranked = _rrf_fuse(bm25_rows, vec_rows, top_k)

    out: list[dict] = []
    for row, score in ranked:
        d = dict(row)
        d["score"] = float(score)
        out.append(d)
    return out
