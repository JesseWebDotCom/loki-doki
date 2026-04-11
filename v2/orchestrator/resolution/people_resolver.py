"""People resolver for the v2 prototype.

Pulls candidate person mentions from a chunk's spaCy entities + noun
chunks, then asks the :class:`PeopleDBAdapter` to bind them to a
concrete record. Ambiguity surfaces as ``unresolved`` markers so the
combiner / Gemma fallback can ask the user instead of guessing.
"""
from __future__ import annotations

from typing import Iterable

from v2.orchestrator.adapters.people_db import PeopleDBAdapter, PersonMatch
from v2.orchestrator.core.types import ChunkExtraction, RequestChunk, ResolutionResult, RouteMatch

PEOPLE_CAPABILITIES = {
    "send_text_message",
    "call_person",
    "lookup_person",
}


def resolve_people(
    chunk: RequestChunk,
    extraction: ChunkExtraction,
    route: RouteMatch,
    adapter: PeopleDBAdapter,
) -> ResolutionResult | None:
    """Return a populated :class:`ResolutionResult` for people-flavored requests."""
    if route.capability not in PEOPLE_CAPABILITIES:
        return None

    mentions = list(_collect_mentions(extraction))
    if not mentions:
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target="",
            source="missing_person",
            confidence=route.confidence,
            unresolved=["person:missing"],
        )

    matches: list[PersonMatch] = []
    for mention in mentions:
        result = adapter.resolve(mention)
        if result is not None:
            matches.append(result)

    if not matches:
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target=mentions[0],
            source="unresolved_person",
            confidence=route.confidence,
            unresolved=[f"person:{mention}" for mention in mentions],
            notes=[f"could not resolve {mentions[0]}"],
        )

    primary = matches[0]
    if primary.ambiguous and len({record.id for record in primary.candidates}) > 1:
        candidate_names = [record.name for record in primary.candidates]
        return ResolutionResult(
            chunk_index=chunk.index,
            resolved_target=primary.record.name,
            source="ambiguous_person",
            confidence=round(primary.score / 100, 3),
            candidate_values=candidate_names,
            unresolved=[f"person_ambiguous:{primary.matched_alias}"],
            params={
                "person_id": primary.record.id,
                "person_name": primary.record.name,
                "relationship": primary.record.relationship,
                "matched_alias": primary.matched_alias,
            },
            notes=[f"multiple matches for {primary.matched_alias}"],
        )

    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=primary.record.name,
        source="people_db",
        confidence=round(primary.score / 100, 3),
        context_value=primary.record.name,
        params={
            "person_id": primary.record.id,
            "person_name": primary.record.name,
            "relationship": primary.record.relationship,
            "matched_alias": primary.matched_alias,
        },
    )


def _collect_mentions(extraction: ChunkExtraction) -> Iterable[str]:
    seen: set[str] = set()
    for ent_text, ent_label in extraction.entities:
        if ent_label != "PERSON":
            continue
        normalized = ent_text.strip()
        if normalized and normalized.lower() not in seen:
            seen.add(normalized.lower())
            yield normalized
    for subject in extraction.subject_candidates:
        normalized = subject.strip()
        if not normalized:
            continue
        lower = normalized.lower()
        if lower in seen:
            continue
        if not _looks_like_person(normalized):
            continue
        seen.add(lower)
        yield normalized


def _looks_like_person(value: str) -> bool:
    cleaned = value.strip().strip("'\"")
    if not cleaned:
        return False
    head = cleaned.split()[0]
    return head[0].isupper() or head.lower() in {
        "mom", "dad", "mother", "father", "sis", "bro", "ma", "pa",
    }
