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


def resolve_person(
    store: MemoryStore,
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
    store: MemoryStore,
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
