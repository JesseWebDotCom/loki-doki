"""
Tier 3 (episodic) read path — episode retrieval via BM25 + recency RRF.

Split from ``reader.py`` for file-size hygiene. All public symbols are
re-exported by ``reader.py`` so existing imports are unaffected.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from lokidoki.orchestrator.memory.reader_search import (
    _build_fts_match,
    _clean_query_terms,
    score_facts_rrf,
)
from lokidoki.orchestrator.memory.store import MemoryStore

log = logging.getLogger("lokidoki.orchestrator.memory.reader")


@dataclass(frozen=True)
class EpisodeHit:
    """A single retrieved episode from Tier 3."""

    episode_id: int
    owner_user_id: int
    title: str
    summary: str
    topic_scope: str | None
    sentiment: str | None
    start_at: str
    score: float
    sources: tuple[str, ...] = field(default_factory=tuple)


def _episode_bm25_query(
    store: MemoryStore,
    owner_user_id: int,
    terms: list[str],
    top_k: int,
    topic_scope: str | None,
) -> list[tuple[int, float]]:
    """Run BM25 over ``episodes_fts`` and return ``(episode_id, score)`` pairs."""
    match = _build_fts_match(terms)
    if topic_scope is not None:
        sql = """
            SELECT episodes_fts.rowid AS episode_id, bm25(episodes_fts) AS score
            FROM episodes_fts
            JOIN episodes ON episodes.id = episodes_fts.rowid
            WHERE episodes_fts MATCH ?
              AND episodes.owner_user_id = ?
              AND episodes.topic_scope = ?
            ORDER BY score
            LIMIT ?
        """
        params: tuple = (match, owner_user_id, topic_scope, top_k * 5)
    else:
        sql = """
            SELECT episodes_fts.rowid AS episode_id, bm25(episodes_fts) AS score
            FROM episodes_fts
            JOIN episodes ON episodes.id = episodes_fts.rowid
            WHERE episodes_fts MATCH ?
              AND episodes.owner_user_id = ?
            ORDER BY score
            LIMIT ?
        """
        params = (match, owner_user_id, top_k * 5)
    try:
        rows = store._conn.execute(sql, params).fetchall()
        return [(int(row["episode_id"]), float(row["score"])) for row in rows]
    except Exception as exc:  # noqa: BLE001
        log.warning("memory reader episode BM25 failed: %s", exc)
        return []


def _episode_recency_scan(
    store: MemoryStore,
    owner_user_id: int,
    top_k: int,
    topic_scope: str | None,
) -> list[tuple[int, float]]:
    """Fetch the most recent episodes and return ``(episode_id, rank_score)`` pairs."""
    if topic_scope is not None:
        sql = """
            SELECT id FROM episodes
            WHERE owner_user_id = ? AND topic_scope = ?
            ORDER BY start_at DESC, id DESC LIMIT ?
        """
        params: tuple = (owner_user_id, topic_scope, top_k * 3)
    else:
        sql = """
            SELECT id FROM episodes
            WHERE owner_user_id = ?
            ORDER BY start_at DESC, id DESC LIMIT ?
        """
        params = (owner_user_id, top_k * 3)
    hits: list[tuple[int, float]] = []
    try:
        rows = store._conn.execute(sql, params).fetchall()
        for rank, row in enumerate(rows, start=1):
            hits.append((int(row["id"]), 1.0 / rank))
    except Exception as exc:  # noqa: BLE001
        log.warning("memory reader episode recency scan failed: %s", exc)
    return hits


def _hydrate_episode_hits(
    store: MemoryStore,
    owner_user_id: int,
    fused: dict,
    top_k: int,
) -> list[EpisodeHit]:
    """Load full episode rows for fused ids and return sorted EpisodeHit list."""
    episode_ids = list(fused.keys())
    placeholders = ",".join("?" * len(episode_ids))
    sql = f"""
        SELECT id, owner_user_id, title, summary, topic_scope,
               sentiment, start_at
        FROM episodes
        WHERE id IN ({placeholders}) AND owner_user_id = ?
    """
    rows = store._conn.execute(sql, list(episode_ids) + [owner_user_id]).fetchall()
    hits: list[EpisodeHit] = []
    for row in rows:
        score, sources = fused[int(row["id"])]
        hits.append(
            EpisodeHit(
                episode_id=int(row["id"]),
                owner_user_id=int(row["owner_user_id"]),
                title=str(row["title"]),
                summary=str(row["summary"]),
                topic_scope=row["topic_scope"],
                sentiment=row["sentiment"],
                start_at=str(row["start_at"]),
                score=score,
                sources=tuple(sources),
            )
        )
    hits.sort(key=lambda h: (-h.score, h.episode_id))
    return hits[:top_k]


def read_episodes(
    store: MemoryStore,
    owner_user_id: int,
    query: str,
    *,
    top_k: int = 2,
    topic_scope: str | None = None,
) -> list[EpisodeHit]:
    """Lazy Tier 3 read path: only call when ``need_episode`` is set.

    Runs BM25 over ``episodes_fts.summary`` with a temporal-recency
    boost. Optional ``topic_scope`` filter narrows to episodes tagged
    with that scope. Returns the top-k hits.

    M4 ships BM25-only; vectors deferred to M4.5.
    """
    terms = _clean_query_terms(query)
    bm25_hits: list[tuple[int, float]] = (
        _episode_bm25_query(store, owner_user_id, terms, top_k, topic_scope)
        if terms else []
    )
    recency_hits = _episode_recency_scan(store, owner_user_id, top_k, topic_scope)
    fused = score_facts_rrf([("bm25", bm25_hits), ("recency", recency_hits)])
    if not fused:
        return []
    return _hydrate_episode_hits(store, owner_user_id, fused, top_k)
