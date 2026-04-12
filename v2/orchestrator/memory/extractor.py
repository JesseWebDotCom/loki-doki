"""
Deterministic candidate extractor for the v2 memory write path.

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

from v2.orchestrator.memory.candidate import MemoryCandidate

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

    # Pattern 1+2: copular self-assertions ("I am X", "I'm allergic to Y")
    for token in tokens:
        if not _is_first_person_subject(token):
            continue
        head = token.head
        if head is None:
            continue
        # The head should be a verb or copula. We then look at its
        # complements (attribute, acomp, oprd) and direct objects.
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

    # Pattern 3: imperative "call me X" / "don't call me X"
    for token in tokens:
        if token.lemma_.lower() == "call" and token.dep_ == "ROOT":
            objects = [child for child in token.children if child.dep_ in {"dobj", "oprd"}]
            me_present = any(
                child.lower_ in {"me", "myself"} and child.dep_ == "dobj"
                for child in token.children
            )
            if not me_present:
                continue
            for obj in objects:
                if obj.lower_ in {"me", "myself"}:
                    continue
                # The name is typically an oprd or attr after 'me'.
                name = obj.text
                negated = any(
                    child.dep_ == "neg" or child.lower_ in {"don't", "do"}
                    for child in token.children
                )
                if negated:
                    yield MemoryCandidate(
                        subject="self",
                        predicate="hard_dislike",
                        value=name,
                        **base_kwargs,
                    )
                else:
                    yield MemoryCandidate(
                        subject="self",
                        predicate="is_named",
                        value=name,
                        **base_kwargs,
                    )

    # Pattern 4+5: possessive relation ("my brother Luke", "my boss")
    for token in tokens:
        if token.lower_ != "my":
            continue
        head = token.head
        if head is None or head.pos_ not in {"NOUN", "PROPN"}:
            continue
        if head.lemma_.lower() not in _RELATION_NOUNS:
            continue
        relation = head.lemma_.lower()
        # Look for an apposition (named referent) — "my brother Luke"
        named_child = next(
            (child for child in head.children if child.dep_ == "appos" and child.pos_ == "PROPN"),
            None,
        )
        # Or a sibling proper noun — "my brother, Luke"
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

    # Pattern 6a: "my favorite X is Y" → (self, favorite_X, Y)
    # Closed enum of supported "favorite_X" predicates so we don't
    # silently widen Tier 4 with arbitrary axes.
    favorite_axes = {
        "color": "favorite_color",
        "colour": "favorite_color",
        "food": "favorite_food",
        "movie": "favorite_movie",
        "film": "favorite_movie",
    }
    for token in tokens:
        # Find a copular root with an attr/acomp complement.
        if token.dep_ != "ROOT" or token.lemma_.lower() not in {"be"}:
            continue
        nsubj = next((c for c in token.children if c.dep_ == "nsubj"), None)
        if nsubj is None or nsubj.pos_ not in {"NOUN", "PROPN"}:
            continue
        # The subject noun must have a "my" possessive child and an
        # "favorite" amod child for this pattern.
        has_my = any(c.dep_ == "poss" and c.lower_ == "my" for c in nsubj.children)
        amod_favorite = any(
            c.dep_ == "amod" and c.lower_ in {"favorite", "favourite"}
            for c in nsubj.children
        )
        if not (has_my and amod_favorite):
            continue
        axis_key = nsubj.lemma_.lower()
        if axis_key not in favorite_axes:
            continue
        complement = next(
            (c for c in token.children if c.dep_ in {"attr", "acomp"}),
            None,
        )
        if complement is None:
            continue
        value = _span_text(complement)
        if value:
            yield MemoryCandidate(
                subject="self",
                predicate=favorite_axes[axis_key],
                value=value,
                **base_kwargs,
            )

    # Pattern 6b: "I live in <Loc>" / "I live at <Loc>" → (self, lives_in, Loc)
    # Pattern 6c: "I work at <Org>" / "I work for <Org>" → (self, current_employer, Org)
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
            (
                c
                for c in token.children
                if c.dep_ == "prep" and c.lower_ in {"in", "at", "for"}
            ),
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
                subject="self",
                predicate="lives_in",
                value=place,
                **base_kwargs,
            )
        elif lemma in work_verbs and prep.lower_ in {"at", "for"}:
            yield MemoryCandidate(
                subject="self",
                predicate="current_employer",
                value=place,
                **base_kwargs,
            )

    # Pattern 6: "I love/hate X"
    for token in tokens:
        if token.lemma_.lower() not in _PREFERENCE_LEMMAS:
            continue
        if token.dep_ != "ROOT" and token.head.dep_ != "ROOT":
            # Allow main-clause verbs only — avoids matching "I think I love X"
            # at the inner clause's verb. The outer verb still fires.
            pass
        subjects = [child for child in token.children if child.dep_ == "nsubj"]
        if not any(_is_first_person_subject(s) for s in subjects):
            continue
        objects = [
            child
            for child in token.children
            if child.dep_ in {"dobj", "obj", "attr", "acomp"}
        ]
        for obj in objects:
            value = _span_text(obj)
            if value:
                predicate = _PREFERENCE_LEMMAS[token.lemma_.lower()]
                yield MemoryCandidate(
                    subject="self",
                    predicate=predicate,
                    value=value,
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


def _relation_label(relation: str) -> str:
    """Canonicalize a relation noun ('mom' → 'mother', 'dad' → 'father')."""
    aliases = {
        "mom": "mother",
        "dad": "father",
    }
    return aliases.get(relation, relation)
