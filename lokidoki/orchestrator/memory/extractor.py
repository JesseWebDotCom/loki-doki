"""
Deterministic candidate extractor for the memory write path.

Walks the spaCy parse tree of each request chunk and proposes
``MemoryCandidate`` triples for downstream gating. **Pattern matching is
applied to dependency-tree structure, not to user-input strings** —
that is the boundary the CLAUDE.md hard rule draws between allowed
parse-tree analysis and forbidden regex/keyword classification of user
intent. We never inspect ``user_input`` text to decide what the user
*meant*; we walk dependency edges to find self-assertions, possessive
relationships, and copular predications.

Phase status: M1 — produces a small but useful set of candidate shapes.
The phase gate's recall target (≥ 0.70 on the should-write bucket) is
designed for this extractor's output. Wider coverage lands in M2/M4
once the read path and decomposer integration give us more signals.

Patterns covered in M1 (each documented inline):

1. ``I am X``  → (self, works_as | is_named, X)
2. ``I'm vegetarian / allergic to X / on Pacific time`` → typed predicates
3. ``call me X``  → (self, is_named, X)
4. ``my <relation> <Name>``  → (person:Name, is_relation, <relation>)
5. ``my <handle>`` (without a name)  → (handle:my <handle>, is_relation, <handle>)
6. ``I love / hate / prefer X``  → (self, prefers | hard_dislike, X)

Anything not matching a pattern is silently dropped — the extractor
is intentionally conservative because the gate chain after it is
strict, and we don't want to flood the regression log with garbage.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterator

from lokidoki.orchestrator.memory.candidate import MemoryCandidate

# Closed mapping from common copular complements to typed predicates.
# Each entry has the predicate name and an optional value-extractor
# strategy: ``"complement"`` (use the matched complement string) or
# ``"object_of:<prep>"`` (use the noun chunk after the named preposition).
_COPULAR_PATTERNS: dict[str, tuple[str, str]] = {
    "vegetarian": ("has_dietary_restriction", "literal:vegetarian"),
    "vegan": ("has_dietary_restriction", "literal:vegan"),
    "allergic": ("has_allergy", "object_of:to"),
    "lactose intolerant": ("has_allergy", "literal:lactose"),
}

# Predicates expressing strong preference / dislike. The lemma drives
# the typed predicate; the direct object drives the value.
_PREFERENCE_LEMMAS: dict[str, str] = {
    "love": "prefers",
    "like": "prefers",
    "prefer": "prefers",
    "enjoy": "prefers",
    "hate": "hard_dislike",
    "loathe": "hard_dislike",
    "despise": "hard_dislike",
}

# Common possessive relation handles. The set is intentionally narrow
# to avoid false positives. Anything not on this list falls into the
# generic ``handle:my <noun>`` path which Gate 2 already accepts.
_RELATION_NOUNS: frozenset[str] = frozenset(
    {
        "brother",
        "sister",
        "mother",
        "mom",
        "father",
        "dad",
        "wife",
        "husband",
        "partner",
        "spouse",
        "son",
        "daughter",
        "uncle",
        "aunt",
        "cousin",
        "grandmother",
        "grandfather",
        "neighbor",
        "boss",
        "therapist",
        "doctor",
        "barista",
        "coworker",
        "colleague",
    }
)


@dataclass
class ExtractionContext:
    owner_user_id: int = 0
    chunk_index: int = 0
    source_text: str = ""


def extract_candidates(
    parse_doc: Any,
    *,
    context: ExtractionContext,
) -> list[MemoryCandidate]:
    """Walk the parse tree and produce a list of memory candidates.

    The walker is intentionally short. Adding new patterns is fine, but
    each addition must be testable against the extraction corpus.
    """
    if parse_doc is None:
        return []
    out: list[MemoryCandidate] = []
    seen: set[tuple[str, str, str]] = set()
    for sent in getattr(parse_doc, "sents", []) or []:
        for candidate in _walk_sentence(sent, context):
            key = (candidate.subject, candidate.predicate, candidate.value)
            if key in seen:
                continue
            seen.add(key)
            out.append(candidate)
    return out


def _walk_sentence(
    sent: Any,
    context: ExtractionContext,
) -> Iterator[MemoryCandidate]:
    """Yield candidates from one sentence's dep tree."""
    sent_text = getattr(sent, "text", "") or context.source_text
    base_kwargs = {
        "source_text": sent_text or context.source_text,
        "chunk_index": context.chunk_index,
        "owner_user_id": context.owner_user_id,
    }
    tokens = list(sent)
    yield from _extract_copular_patterns(tokens, base_kwargs)
    yield from _extract_call_me(tokens, base_kwargs)

    # Patterns 4-6 extracted to extractor_patterns.py for file size.
    from lokidoki.orchestrator.memory.extractor_patterns import (
        extract_favorites,
        extract_location_and_work,
        extract_possessive_relations,
        extract_preferences,
    )
    yield from extract_possessive_relations(tokens, base_kwargs)
    yield from extract_favorites(tokens, base_kwargs)
    yield from extract_location_and_work(tokens, base_kwargs)
    yield from extract_preferences(tokens, base_kwargs)


def _extract_copular_patterns(
    tokens: list[Any],
    base_kwargs: dict[str, Any],
) -> Iterator[MemoryCandidate]:
    """Pattern 1+2: copular self-assertions ("I am X", "I'm allergic to Y")."""
    for token in tokens:
        if not _is_first_person_subject(token):
            continue
        head = token.head
        if head is None:
            continue
        complements = [
            child
            for child in head.children
            if child.dep_ in {"attr", "acomp", "oprd", "dobj", "advmod"}
        ]
        for complement in complements:
            text_key = complement.lemma_.lower() or complement.text.lower()
            if text_key in _COPULAR_PATTERNS:
                predicate, strategy = _COPULAR_PATTERNS[text_key]
                value = _resolve_value(complement, head, strategy)
                if value:
                    yield MemoryCandidate(
                        subject="self",
                        predicate=predicate,
                        value=value,
                        **base_kwargs,
                    )
                    continue
            # Generic "I'm a <noun>" → works_as
            if complement.dep_ == "attr" and complement.pos_ in {"NOUN", "PROPN"}:
                yield MemoryCandidate(
                    subject="self",
                    predicate="works_as",
                    value=complement.text,
                    **base_kwargs,
                )


def _extract_call_me(
    tokens: list[Any],
    base_kwargs: dict[str, Any],
) -> Iterator[MemoryCandidate]:
    """Pattern 3: imperative "call me X" / "don't call me X"."""
    for token in tokens:
        if not (token.lemma_.lower() == "call" and token.dep_ == "ROOT"):
            continue
        objects = [child for child in token.children if child.dep_ in {"dobj", "oprd"}]
        me_present = any(
            child.lower_ in {"me", "myself"} and child.dep_ == "dobj"
            for child in token.children
        )
        if not me_present:
            continue
        negated = any(
            child.dep_ == "neg" or child.lower_ in {"don't", "do"}
            for child in token.children
        )
        for obj in objects:
            if obj.lower_ in {"me", "myself"}:
                continue
            name = obj.text
            predicate = "hard_dislike" if negated else "is_named"
            yield MemoryCandidate(
                subject="self",
                predicate=predicate,
                value=name,
                **base_kwargs,
            )


def _is_first_person_subject(token: Any) -> bool:
    return (
        getattr(token, "dep_", "") == "nsubj"
        and getattr(token, "lower_", "") in {"i", "i'm", "im"}
    )


def _resolve_value(complement: Any, head: Any, strategy: str) -> str:
    if strategy.startswith("literal:"):
        return strategy.split(":", 1)[1]
    if strategy == "complement":
        return _span_text(complement)
    if strategy.startswith("object_of:"):
        prep = strategy.split(":", 1)[1]
        # Look for a prep child of the complement (or of the head) whose
        # text matches `prep`, then return the noun chunk under it.
        candidates = list(complement.children) + list(head.children)
        for child in candidates:
            if child.dep_ == "prep" and child.lower_ == prep:
                for grandchild in child.children:
                    if grandchild.dep_ in {"pobj", "obj"}:
                        return _span_text(grandchild)
    return _span_text(complement)


def _span_text(token: Any) -> str:
    """Return the noun-chunk text under `token`, including modifiers."""
    if token is None:
        return ""
    # subtree gives us the contiguous span under this token in dep order.
    subtree = list(token.subtree)
    if not subtree:
        return token.text
    start = min(t.i for t in subtree)
    end = max(t.i for t in subtree) + 1
    doc = token.doc
    return doc[start:end].text


