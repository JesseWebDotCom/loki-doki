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

    # BM25 over episodes_fts
    bm25_hits: list[tuple[int, float]] = []
    if terms:
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
            bm25_hits = [(int(row["episode_id"]), float(row["score"])) for row in rows]
        except Exception as exc:  # noqa: BLE001
            log.warning("memory reader episode BM25 failed: %s", exc)

    # Temporal recency fallback: if BM25 found nothing, or to top up,
    # grab the most recent episodes by start_at.
    recency_hits: list[tuple[int, float]] = []
    if topic_scope is not None:
        recency_sql = """
            SELECT id FROM episodes
            WHERE owner_user_id = ? AND topic_scope = ?
            ORDER BY start_at DESC, id DESC LIMIT ?
        """
        recency_params: tuple = (owner_user_id, topic_scope, top_k * 3)
    else:
        recency_sql = """
            SELECT id FROM episodes
            WHERE owner_user_id = ?
            ORDER BY start_at DESC, id DESC LIMIT ?
        """
        recency_params = (owner_user_id, top_k * 3)
    try:
        rows = store._conn.execute(recency_sql, recency_params).fetchall()
        for rank, row in enumerate(rows, start=1):
            recency_hits.append((int(row["id"]), 1.0 / rank))
    except Exception as exc:  # noqa: BLE001
        log.warning("memory reader episode recency scan failed: %s", exc)

    # RRF fusion
    fused = score_facts_rrf([("bm25", bm25_hits), ("recency", recency_hits)])
    if not fused:
        return []

    # Hydrate
    episode_ids = list(fused.keys())
    placeholders = ",".join("?" * len(episode_ids))
    hydrate_sql = f"""
        SELECT id, owner_user_id, title, summary, topic_scope,
               sentiment, start_at
        FROM episodes
        WHERE id IN ({placeholders}) AND owner_user_id = ?
    """
    hydrate_params: list = list(episode_ids) + [owner_user_id]
    rows = store._conn.execute(hydrate_sql, hydrate_params).fetchall()

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
