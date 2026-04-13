"""Individual gate implementations for the memory write-path gate chain.

All public symbols are re-exported from ``gates.py``.
"""
from __future__ import annotations

from typing import Any, Iterable

from pydantic import ValidationError

from lokidoki.orchestrator.memory.candidate import MemoryCandidate
from lokidoki.orchestrator.memory.gates import GateName, GateResult
from lokidoki.orchestrator.memory.predicates import (
    is_tier4_predicate,
    is_tier5_predicate,
)


# ---------------------------------------------------------------------------
# Gate 1 — clause shape (parse-tree non-interrogative)
# ---------------------------------------------------------------------------

# Closed whitelist of info-request lemmas (design §3 Gate 1).
_INFO_REQUEST_LEMMAS: frozenset[str] = frozenset(
    {"tell", "explain", "show", "list", "find", "search", "look", "describe", "define"}
)

# WH-token POS tags from spaCy (WP/WP$/WRB/WDT).
_WH_TAGS: frozenset[str] = frozenset({"WP", "WP$", "WRB", "WDT"})


def _has_question_mark(sentence_text: str) -> bool:
    return "?" in sentence_text


def _wh_fronted(tokens: list[Any]) -> bool:
    """True if the first non-trivial token in the sentence is a WH word."""
    for token in tokens:
        if getattr(token, "is_punct", False):
            continue
        if getattr(token, "is_space", False):
            continue
        return getattr(token, "tag_", "") in _WH_TAGS
    return False


def _subject_aux_inversion(tokens: list[Any]) -> bool:
    """True if there's a sentence-leading aux/copula before any nominal subject."""
    saw_aux = False
    for token in tokens:
        if getattr(token, "is_punct", False) or getattr(token, "is_space", False):
            continue
        dep = getattr(token, "dep_", "")
        tag = getattr(token, "tag_", "")
        if dep in {"aux", "auxpass"} or tag in {"MD"}:
            saw_aux = True
            return True
        return False
    return saw_aux


def _info_request_imperative(tokens: list[Any]) -> bool:
    """True if the sentence is an info-request imperative ('tell me about …')."""
    root = next((tok for tok in tokens if getattr(tok, "dep_", "") == "ROOT"), None)
    if root is None:
        return False
    lemma = getattr(root, "lemma_", "").lower()
    if lemma not in _INFO_REQUEST_LEMMAS:
        return False
    has_real_subject = any(
        getattr(child, "dep_", "") == "nsubj"
        and getattr(child, "lower_", "") not in {"you", ""}
        for child in getattr(root, "children", [])
    )
    return not has_real_subject


def _check_sentence_shape(
    tokens: list[Any],
    sent_text: str,
) -> GateResult | None:
    """Return a failing GateResult if the sentence looks interrogative, else None."""
    if _has_question_mark(sent_text) and _wh_fronted(tokens):
        return GateResult(GateName.CLAUSE_SHAPE, passed=False, reason="wh_fronted_question")
    if _wh_fronted(tokens):
        return GateResult(GateName.CLAUSE_SHAPE, passed=False, reason="wh_fronted")
    if _subject_aux_inversion(tokens) and _has_question_mark(sent_text):
        return GateResult(GateName.CLAUSE_SHAPE, passed=False, reason="subject_aux_inversion")
    if _info_request_imperative(tokens):
        return GateResult(GateName.CLAUSE_SHAPE, passed=False, reason="info_request_imperative")
    return None


def gate_clause_shape(
    candidate: MemoryCandidate,
    parse_doc: Any,
) -> GateResult:
    """Gate 1 — non-interrogative parse-tree check."""
    if parse_doc is None:
        if _has_question_mark(candidate.source_text):
            return GateResult(
                GateName.CLAUSE_SHAPE,
                passed=False,
                reason="question_mark_no_parse",
            )
        return GateResult(GateName.CLAUSE_SHAPE, passed=True)

    sentences = list(getattr(parse_doc, "sents", []) or [])
    if not sentences:
        sentences = [parse_doc]

    for sent in sentences:
        tokens = list(sent)
        sent_text = getattr(sent, "text", "") or candidate.source_text
        failed = _check_sentence_shape(tokens, sent_text)
        if failed is not None:
            return failed

    if _has_question_mark(candidate.source_text):
        return GateResult(
            GateName.CLAUSE_SHAPE,
            passed=False,
            reason="trailing_question_mark",
        )

    return GateResult(GateName.CLAUSE_SHAPE, passed=True)


_IDENTITY_ESTABLISHING_PREDICATES: frozenset[str] = frozenset(
    {"is_relation", "is_named", "has_pronoun"}
)


_PUBLIC_OR_STRANGER_NAMES: frozenset[str] = frozenset(
    {
        "the president",
        "the prime minister",
        "the king",
        "the queen",
        "some random guy",
        "some random person",
        "that guy on tv",
        "that woman on tv",
        "that person",
        "stranger",
    }
)


def _looks_like_public_figure_or_stranger(name: str) -> str | None:
    lowered = name.strip().lower()
    if lowered in _PUBLIC_OR_STRANGER_NAMES:
        return lowered
    return None


def _gate_person_subject(
    candidate: MemoryCandidate,
    resolved_people: Iterable[str] | None,
) -> GateResult:
    """Validate a ``person:`` prefixed subject."""
    name = candidate.subject.split(":", 1)[1].strip()
    if not name:
        return GateResult(GateName.SUBJECT, passed=False, reason="empty_person_name")
    public_or_stranger = _looks_like_public_figure_or_stranger(name)
    if public_or_stranger:
        return GateResult(
            GateName.SUBJECT,
            passed=False,
            reason=f"public_or_stranger:{public_or_stranger}",
        )
    resolved = {n.lower() for n in (resolved_people or [])}
    if name.lower() in resolved:
        return GateResult(GateName.SUBJECT, passed=True, reason="resolved_person")
    if candidate.predicate in _IDENTITY_ESTABLISHING_PREDICATES:
        return GateResult(
            GateName.SUBJECT, passed=True, reason="new_person_via_identity_predicate"
        )
    return GateResult(GateName.SUBJECT, passed=False, reason="unresolved_person")


def _gate_entity_subject(
    subject: str,
    known_entities: Iterable[str] | None,
) -> GateResult:
    """Validate an ``entity:`` prefixed subject."""
    name = subject.split(":", 1)[1].strip().lower()
    known = {n.lower() for n in (known_entities or [])}
    if name in known:
        return GateResult(GateName.SUBJECT, passed=True, reason="known_entity")
    return GateResult(GateName.SUBJECT, passed=False, reason="unknown_entity")


def gate_subject(
    candidate: MemoryCandidate,
    resolved_people: Iterable[str] | None = None,
    *,
    known_entities: Iterable[str] | None = None,
) -> GateResult:
    """Gate 2 — subject must be self / resolved person / handle /
    new person via identity predicate / known entity."""
    subject = candidate.subject
    if subject == "self":
        return GateResult(GateName.SUBJECT, passed=True, reason="self")
    if subject.startswith("handle:"):
        return GateResult(GateName.SUBJECT, passed=True, reason="provisional_handle")
    if subject.startswith("person:"):
        return _gate_person_subject(candidate, resolved_people)
    if subject.startswith("entity:"):
        return _gate_entity_subject(subject, known_entities)
    return GateResult(GateName.SUBJECT, passed=False, reason="unknown_subject_shape")


# ---------------------------------------------------------------------------
# Gate 3 — predicate validity
# ---------------------------------------------------------------------------


def gate_predicate(candidate: MemoryCandidate) -> GateResult:
    """Gate 3 — predicate is in the Tier 4 OR Tier 5 closed enum."""
    if is_tier4_predicate(candidate.predicate) or is_tier5_predicate(candidate.predicate):
        return GateResult(GateName.PREDICATE, passed=True)
    return GateResult(
        GateName.PREDICATE,
        passed=False,
        reason=f"unknown_predicate:{candidate.predicate}",
    )


# ---------------------------------------------------------------------------
# Gate 4 — strict Pydantic validation (no repair loop)
# ---------------------------------------------------------------------------


def gate_schema(raw: Any) -> tuple[GateResult, MemoryCandidate | None]:
    """Gate 4 — strict Pydantic validation. No repair loop."""
    if isinstance(raw, MemoryCandidate):
        return GateResult(GateName.SCHEMA, passed=True), raw
    if not isinstance(raw, dict):
        return (
            GateResult(GateName.SCHEMA, passed=False, reason="not_a_dict"),
            None,
        )
    try:
        candidate = MemoryCandidate.model_validate(raw)
    except ValidationError as exc:
        return (
            GateResult(
                GateName.SCHEMA,
                passed=False,
                reason=f"schema_invalid:{exc.error_count()}_errors",
            ),
            None,
        )
    return GateResult(GateName.SCHEMA, passed=True), candidate


# ---------------------------------------------------------------------------
# Gate 5 — intent context (defense in depth)
# ---------------------------------------------------------------------------

WRITE_ALLOWING_INTENTS: frozenset[str] = frozenset(
    {
        "assertive_chat",
        "self_disclosure",
        "correction",
        "command_with_self_assertion",
    }
)

WRITE_DENYING_INTENTS: frozenset[str] = frozenset(
    {
        "greeting",
        "joke",
        "quip",
        "command_to_assistant",
        "info_request",
        "question",
        "clarification_request",
    }
)


def gate_intent(candidate: MemoryCandidate, decomposed_intent: str | None) -> GateResult:
    """Gate 5 — intent label gates the write."""
    if decomposed_intent is None:
        return GateResult(GateName.INTENT, passed=True, reason="no_intent_pass_through")
    if decomposed_intent in WRITE_DENYING_INTENTS:
        return GateResult(
            GateName.INTENT,
            passed=False,
            reason=f"deny_intent:{decomposed_intent}",
        )
    if decomposed_intent in WRITE_ALLOWING_INTENTS:
        return GateResult(GateName.INTENT, passed=True, reason=f"allow:{decomposed_intent}")
    return GateResult(GateName.INTENT, passed=True, reason="unknown_intent_pass_through")
