from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

try:
    from rapidfuzz import fuzz
except Exception:  # pragma: no cover - fallback only matters if dep is missing
    from difflib import SequenceMatcher

    class _FallbackFuzz:
        @staticmethod
        def ratio(left: str, right: str) -> float:
            return SequenceMatcher(None, left, right).ratio() * 100.0

        @staticmethod
        def partial_ratio(left: str, right: str) -> float:
            return SequenceMatcher(None, left, right).ratio() * 100.0

        @staticmethod
        def token_set_ratio(left: str, right: str) -> float:
            return SequenceMatcher(None, left, right).ratio() * 100.0

    fuzz = _FallbackFuzz()


NOVELTY_PENALTY = 1.1
CONTRADICTION_PENALTY = 1.8
ENTITY_BOOST = 0.8


def relation_match_bonus(*, bucket: str, user_input: str, asks: list[Any], fact: dict) -> float:
    relationish_turn = any(
        getattr(a, "referent_type", "unknown") == "person"
        or "person" in (getattr(a, "referent_scope", []) or [])
        or getattr(a, "capability_need", "none") == "people_lookup"
        for a in (asks or [])
    )
    if not relationish_turn:
        return 0.0
    if bucket == "relational_graph":
        return 1.0
    query = normalize_text(user_input)
    relationish_text = " ".join(
        normalize_text(part)
        for part in (
            fact.get("subject"),
            fact.get("predicate"),
            fact.get("value"),
        )
        if part
    )
    if relationish_text and fuzz.partial_ratio(query, relationish_text) >= 85:
        return 0.65
    return 0.0


def score_memory_candidate(
    fact: dict,
    *,
    bucket: str,
    user_input: str,
    asks: list[Any],
    retrieval_rank: int,
    session_seen_fact_ids: set[int],
    entity_boost_enabled: bool,
) -> float:
    retrieval_score = float(fact.get("score", 0.0) or 0.0) * 2.5
    rank_score = max(0.0, 2.3 - (float(retrieval_rank) * 0.4))
    confidence_score = float(fact.get("confidence", 0.0) or 0.0) * 2.0
    recency_score = recency_bonus(fact)
    relation_score = relation_match_bonus(
        bucket=bucket,
        user_input=user_input,
        asks=asks,
        fact=fact,
    )
    novelty_penalty = (
        NOVELTY_PENALTY
        if fact.get("id") is not None and int(fact["id"]) in (session_seen_fact_ids or set())
        else 0.0
    )
    contradiction_penalty = contradiction_penalty_for_fact(fact)
    entity_boost = (
        ENTITY_BOOST
        if entity_boost_enabled and fact_matches_query(fact, user_input)
        and str(fact.get("subject_type") or "").strip().lower() == "entity"
        else 0.0
    )
    return (
        retrieval_score
        + rank_score
        + confidence_score
        + recency_score
        + relation_score
        + entity_boost
        - novelty_penalty
        - contradiction_penalty
    )


def recency_bonus(fact: dict) -> float:
    dt = parse_fact_timestamp(fact)
    if dt is None:
        return 0.0
    age_days = max((datetime.now(timezone.utc) - dt).total_seconds() / 86400.0, 0.0)
    if age_days <= 2:
        return 1.2
    if age_days <= 14:
        return 0.8
    if age_days <= 60:
        return 0.4
    if age_days <= 365:
        return 0.1
    return 0.0


def contradiction_penalty_for_fact(fact: dict) -> float:
    status = str(fact.get("status") or "active").strip().lower()
    if status in {"rejected", "superseded"}:
        return CONTRADICTION_PENALTY
    if status in {"contradicted", "ambiguous"}:
        return 1.0
    return 0.0


def fact_matches_query(fact: dict, user_input: str) -> bool:
    query = normalize_text(user_input)
    if not query:
        return False
    for part in (fact.get("subject"), fact.get("predicate"), fact.get("value")):
        text = normalize_text(part)
        if not text:
            continue
        tokens = set(text.split())
        query_tokens = set(query.split())
        overlap = len(tokens & query_tokens)
        if (
            text in query
            or fuzz.partial_ratio(query, text) >= 84
            or (tokens and overlap >= max(1, min(2, len(tokens) // 2)))
        ):
            return True
    return False


def fact_phrase(fact: dict) -> str:
    return " ".join(
        normalize_text(part)
        for part in (
            fact.get("subject"),
            fact.get("predicate"),
            fact.get("value"),
        )
        if part
    ).strip()


def are_near_duplicate_facts(left: dict, right: dict) -> bool:
    a = fact_phrase(left)
    b = fact_phrase(right)
    if not a or not b:
        return False
    return fuzz.token_set_ratio(a, b) >= 94 or fuzz.ratio(a, b) >= 92


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().split())


def parse_fact_timestamp(fact: dict) -> datetime | None:
    for key in ("last_observed_at", "updated_at", "created_at", "valid_from"):
        value = str(fact.get(key) or "").strip()
        if not value:
            continue
        parsed = _parse_datetime(value)
        if parsed is not None:
            return parsed
    return None


def _parse_datetime(raw: str) -> datetime | None:
    candidates = [raw]
    if " " in raw and "T" not in raw:
        candidates.append(raw.replace(" ", "T"))
    for candidate in candidates:
        try:
            parsed = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        else:
            parsed = parsed.astimezone(timezone.utc)
        return parsed
    return None
