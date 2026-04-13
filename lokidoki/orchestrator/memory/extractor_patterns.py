"""Extended extraction patterns for the memory write path.

Patterns in this module (each documented inline):

4. ``my <relation> <Name>``  → (person:Name, is_relation, <relation>)
5. ``my <handle>`` (without a name) → (handle:my <handle>, is_relation, <handle>)
6a. ``my favorite X is Y``   → (self, favorite_X, Y)
6b. ``I live in <Loc>``      → (self, lives_in, Loc)
6c. ``I work at <Org>``      → (self, current_employer, Org)
6d. ``I love / hate X``      → (self, prefers | hard_dislike, X)
"""
from __future__ import annotations

from typing import Any, Iterator

from lokidoki.orchestrator.memory.candidate import MemoryCandidate
from lokidoki.orchestrator.memory.extractor import (
    ExtractionContext,
    _PREFERENCE_LEMMAS,
    _RELATION_NOUNS,
    _is_first_person_subject,
    _span_text,
)


def _relation_label(relation: str) -> str:
    """Canonicalize a relation noun ('mom' → 'mother', 'dad' → 'father')."""
    aliases = {"mom": "mother", "dad": "father"}
    return aliases.get(relation, relation)


def extract_possessive_relations(
    tokens: list[Any],
    base_kwargs: dict[str, Any],
) -> Iterator[MemoryCandidate]:
    """Pattern 4+5: possessive relation ('my brother Luke', 'my boss')."""
    for token in tokens:
        if token.lower_ != "my":
            continue
        head = token.head
        if head is None or head.pos_ not in {"NOUN", "PROPN"}:
            continue
        if head.lemma_.lower() not in _RELATION_NOUNS:
            continue
        relation = head.lemma_.lower()
        named_child = next(
            (child for child in head.children if child.dep_ == "appos" and child.pos_ == "PROPN"),
            None,
        )
        if named_child is None:
            for sibling in head.head.children if head.head else []:
                if sibling is head:
                    continue
                if sibling.dep_ == "appos" and sibling.pos_ == "PROPN":
                    named_child = sibling
                    break
        if named_child is not None:
            yield MemoryCandidate(
                subject=f"person:{named_child.text}",
                predicate="is_relation",
                value=_relation_label(relation),
                **base_kwargs,
            )
        else:
            handle = f"my {relation}"
            yield MemoryCandidate(
                subject=f"handle:{handle}",
                predicate="is_relation",
                value=_relation_label(relation),
                **base_kwargs,
            )


def extract_favorites(
    tokens: list[Any],
    base_kwargs: dict[str, Any],
) -> Iterator[MemoryCandidate]:
    """Pattern 6a: 'my favorite X is Y' → (self, favorite_X, Y)."""
    favorite_axes = {
        "color": "favorite_color",
        "colour": "favorite_color",
        "food": "favorite_food",
        "movie": "favorite_movie",
        "film": "favorite_movie",
    }
    for token in tokens:
        candidate = _match_favorite_token(token, favorite_axes, base_kwargs)
        if candidate is not None:
            yield candidate


def _match_favorite_token(
    token: Any,
    favorite_axes: dict[str, str],
    base_kwargs: dict[str, Any],
) -> "MemoryCandidate | None":
    """Return a MemoryCandidate if ``token`` matches a 'my favorite X is Y' pattern."""
    if token.dep_ != "ROOT" or token.lemma_.lower() not in {"be"}:
        return None
    nsubj = next((c for c in token.children if c.dep_ == "nsubj"), None)
    if nsubj is None or nsubj.pos_ not in {"NOUN", "PROPN"}:
        return None
    has_my = any(c.dep_ == "poss" and c.lower_ == "my" for c in nsubj.children)
    amod_favorite = any(
        c.dep_ == "amod" and c.lower_ in {"favorite", "favourite"}
        for c in nsubj.children
    )
    if not (has_my and amod_favorite):
        return None
    axis_key = nsubj.lemma_.lower()
    if axis_key not in favorite_axes:
        return None
    complement = next((c for c in token.children if c.dep_ in {"attr", "acomp"}), None)
    if complement is None:
        return None
    value = _span_text(complement)
    if not value:
        return None
    return MemoryCandidate(
        subject="self",
        predicate=favorite_axes[axis_key],
        value=value,
        **base_kwargs,
    )


def extract_location_and_work(
    tokens: list[Any],
    base_kwargs: dict[str, Any],
) -> Iterator[MemoryCandidate]:
    """Pattern 6b/6c: 'I live in <Loc>' / 'I work at <Org>'."""
    location_verbs = {"live"}
    work_verbs = {"work"}
    for token in tokens:
        if token.dep_ != "ROOT":
            continue
        lemma = token.lemma_.lower()
        if lemma not in (location_verbs | work_verbs):
            continue
        if not any(_is_first_person_subject(c) for c in token.children):
            continue
        prep = next(
            (c for c in token.children if c.dep_ == "prep" and c.lower_ in {"in", "at", "for"}),
            None,
        )
        if prep is None:
            continue
        pobj = next((c for c in prep.children if c.dep_ == "pobj"), None)
        if pobj is None:
            continue
        place = _span_text(pobj)
        if not place:
            continue
        if lemma in location_verbs and prep.lower_ in {"in", "at"}:
            yield MemoryCandidate(
                subject="self", predicate="lives_in", value=place, **base_kwargs,
            )
        elif lemma in work_verbs and prep.lower_ in {"at", "for"}:
            yield MemoryCandidate(
                subject="self", predicate="current_employer", value=place, **base_kwargs,
            )


def extract_preferences(
    tokens: list[Any],
    base_kwargs: dict[str, Any],
) -> Iterator[MemoryCandidate]:
    """Pattern 6d: 'I love/hate X'."""
    for token in tokens:
        if token.lemma_.lower() not in _PREFERENCE_LEMMAS:
            continue
        if token.dep_ != "ROOT" and token.head.dep_ != "ROOT":
            pass
        subjects = [child for child in token.children if child.dep_ == "nsubj"]
        if not any(_is_first_person_subject(s) for s in subjects):
            continue
        objects = [
            child for child in token.children
            if child.dep_ in {"dobj", "obj", "attr", "acomp"}
        ]
        for obj in objects:
            value = _span_text(obj)
            if value:
                predicate = _PREFERENCE_LEMMAS[token.lemma_.lower()]
                yield MemoryCandidate(
                    subject="self", predicate=predicate, value=value, **base_kwargs,
                )
