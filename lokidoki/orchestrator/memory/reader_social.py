"""
Tier 5 (social) read path — person resolution and social context.

Split from ``reader.py`` for file-size hygiene. All public symbols are
re-exported by ``reader.py`` so existing imports are unaffected.
"""
from __future__ import annotations

import logging

from lokidoki.orchestrator.memory.reader import (
    PersonHit,
    PersonResolution,
    _clean_query_terms,
)
from lokidoki.orchestrator.memory.store import MemoryStore

log = logging.getLogger("lokidoki.orchestrator.memory.reader")


def _person_relations(store: MemoryStore, person_id: int) -> tuple[str, ...]:
    rows = store._conn.execute(
        "SELECT relation_label FROM relationships WHERE person_id = ? ORDER BY id",
        (person_id,),
    ).fetchall()
    return tuple(str(row["relation_label"]) for row in rows)


def _row_to_person_hit(
    store: MemoryStore,
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


def _score_fuzzy_candidates(
    store: MemoryStore,
    owner_user_id: int,
    needle: str,
    fuzz,
) -> PersonResolution | None:
    """Run rapidfuzz scoring against all named people rows.

    Returns a ``PersonResolution`` when at least one candidate scores ≥80,
    or ``None`` when no candidates clear the threshold.
    """
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
    if not scored:
        return None
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


def resolve_person(
    store: MemoryStore,
    owner_user_id: int,
    mention: str,
) -> PersonResolution:
    """Resolve a mention to a Tier 5 person row via a four-strategy ladder.

    Strategies: exact name → exact handle → substring name (≥3 chars) → rapidfuzz (≥80).
    Ties at any strategy are ambiguous; Gate 2 rejects ambiguous candidates.
    """
    if not mention or not mention.strip():
        return PersonResolution(None, False, (), "empty_mention")
    needle = mention.strip().lower()

    result = _strategy_exact_name(store, owner_user_id, needle)
    if result is not None:
        return result

    result = _strategy_exact_handle(store, owner_user_id, needle)
    if result is not None:
        return result

    result = _strategy_substring_name(store, owner_user_id, needle)
    if result is not None:
        return result

    result = _strategy_fuzzy(store, owner_user_id, needle)
    if result is not None:
        return result

    return PersonResolution(None, False, (), "no_match")


def _strategy_exact_name(
    store: MemoryStore,
    owner_user_id: int,
    needle: str,
) -> PersonResolution | None:
    """Strategy 1: exact case-insensitive name match."""
    rows = store._conn.execute(
        "SELECT id, owner_user_id, name, handle, provisional "
        "FROM people WHERE owner_user_id = ? AND LOWER(name) = ?",
        (owner_user_id, needle),
    ).fetchall()
    if not rows:
        return None
    hits = tuple(_row_to_person_hit(store, row, score=1.0, matched_via="name") for row in rows)
    if len(hits) > 1:
        return PersonResolution(None, True, hits, "ambiguous_name")
    return PersonResolution(hits[0], False, hits, "exact_name")


def _strategy_exact_handle(
    store: MemoryStore,
    owner_user_id: int,
    needle: str,
) -> PersonResolution | None:
    """Strategy 2: exact handle match (provisional handles)."""
    rows = store._conn.execute(
        "SELECT id, owner_user_id, name, handle, provisional "
        "FROM people WHERE owner_user_id = ? AND LOWER(handle) = ?",
        (owner_user_id, needle),
    ).fetchall()
    if not rows:
        return None
    hits = tuple(_row_to_person_hit(store, row, score=0.95, matched_via="handle") for row in rows)
    if len(hits) > 1:
        return PersonResolution(None, True, hits, "ambiguous_handle")
    return PersonResolution(hits[0], False, hits, "exact_handle")


def _strategy_substring_name(
    store: MemoryStore,
    owner_user_id: int,
    needle: str,
) -> PersonResolution | None:
    """Strategy 3: substring against canonical name (≥3 chars)."""
    if len(needle) < 3:
        return None
    rows = store._conn.execute(
        "SELECT id, owner_user_id, name, handle, provisional "
        "FROM people WHERE owner_user_id = ? "
        "AND name IS NOT NULL AND LOWER(name) LIKE ?",
        (owner_user_id, f"%{needle}%"),
    ).fetchall()
    if not rows:
        return None
    hits = tuple(_row_to_person_hit(store, row, score=0.7, matched_via="name_substring") for row in rows)
    if len(hits) > 1:
        return PersonResolution(None, True, hits, "ambiguous_substring")
    return PersonResolution(hits[0], False, hits, "substring_name")


def _strategy_fuzzy(
    store: MemoryStore,
    owner_user_id: int,
    needle: str,
) -> PersonResolution | None:
    """Strategy 4: optional rapidfuzz fallback (≥80 score)."""
    try:
        from rapidfuzz import fuzz
    except ImportError:
        return None
    return _score_fuzzy_candidates(store, owner_user_id, needle, fuzz)


def read_social_context(
    store: MemoryStore,
    owner_user_id: int,
    query: str,
    *,
    top_k: int = 3,
) -> list[PersonHit]:
    """Tier 5 read path — return the most relevant people for a query.

    Resolves cleaned query terms then tops up with recent people when needed.
    Result is sorted by score descending and capped at top_k.
    """
    seen: dict[int, PersonHit] = {}
    _collect_hits_from_terms(store, owner_user_id, query, seen)
    if len(seen) < top_k:
        _fill_from_recent(store, owner_user_id, seen, top_k)
    hits = sorted(seen.values(), key=lambda h: (-h.score, h.person_id))
    return hits[:top_k]


def _collect_hits_from_terms(
    store: MemoryStore,
    owner_user_id: int,
    query: str,
    seen: dict[int, PersonHit],
) -> None:
    """Resolve each query term and populate ``seen`` with matched PersonHits."""
    terms = _clean_query_terms(query) if query else []
    for term in terms:
        result = resolve_person(store, owner_user_id, term)
        if result.matched is not None:
            seen.setdefault(result.matched.person_id, result.matched)
        elif result.candidates:
            for cand in result.candidates:
                seen.setdefault(cand.person_id, cand)


def _fill_from_recent(
    store: MemoryStore,
    owner_user_id: int,
    seen: dict[int, PersonHit],
    top_k: int,
) -> None:
    """Top up ``seen`` with the most recently updated people rows."""
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
