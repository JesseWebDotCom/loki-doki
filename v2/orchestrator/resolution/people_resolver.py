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
from v2.orchestrator.linguistics import FAMILY_RELATIONS, PRONOUNS

PEOPLE_CAPABILITIES = {
    "send_text_message",
    "call_person",
    "lookup_person",
    "lookup_person_birthday",
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

    mentions = list(_collect_mentions(extraction, chunk_text=chunk.text))
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
            params=_person_params(primary),
            notes=[f"multiple matches for {primary.matched_alias}"],
        )

    return ResolutionResult(
        chunk_index=chunk.index,
        resolved_target=primary.record.name,
        source="people_db",
        confidence=round(primary.score / 100, 3),
        context_value=primary.record.name,
        params=_person_params(primary),
    )


def _person_params(match: PersonMatch) -> dict[str, object]:
    params: dict[str, object] = {
        "person_id": match.record.id,
        "person_name": match.record.name,
        "relationship": match.record.relationship,
        "matched_alias": match.matched_alias,
    }
    if match.record.birthday:
        params["birthday"] = match.record.birthday
    return params


def _collect_mentions(
    extraction: ChunkExtraction,
    *,
    chunk_text: str = "",
) -> Iterable[str]:
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

    # Closed-class family-relation hook: phrases like "my sister's birthday"
    # never become PERSON-tagged entities and the noun chunk head is "my", so
    # the loops above miss them. Scan the chunk text once for any
    # FAMILY_RELATIONS lemma and surface it as a mention. Strict alphabetic
    # tokenization keeps possessives ("sister's") matchable.
    for raw_token in _tokenize_words(chunk_text):
        token = raw_token.lower()
        if token not in FAMILY_RELATIONS:
            continue
        if token in seen:
            continue
        seen.add(token)
        yield token


def _tokenize_words(text: str) -> Iterable[str]:
    word: list[str] = []
    for ch in (text or ""):
        if ch.isalpha():
            word.append(ch)
        else:
            if word:
                yield "".join(word)
                word = []
    if word:
        yield "".join(word)


def _looks_like_person(value: str) -> bool:
    cleaned = value.strip().strip("'\"")
    if not cleaned:
        return False
    head = cleaned.split()[0]
    head_lower = head.lower()
    # Pronouns ("I", "you", "he", "she") are referents, not person names —
    # they belong to the pronoun resolver, not the people resolver.
    if head_lower in PRONOUNS:
        return False
    return head[0].isupper() or head_lower in FAMILY_RELATIONS
