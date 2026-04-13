"""
Layer 1 — structural gate chain for the memory write path.

Five independent gates, each of which can deny a write candidate. The chain
is short-circuit: reject on first failure. No retries. Rejected candidates
get logged to the regression corpus so they can be inspected without
polluting durable storage.

Phase status: M1 — real implementations for all five gates. The president
bug (`"who is the current president"`) dies at Gate 1 because the WH-fronted
question is denied before any further evaluation.

Gate ordering (must not be reordered without updating §3 of the design doc):
    1. clause_shape   — parse-tree non-interrogative
    2. subject        — self / resolved person / known entity
    3. predicate      — closed enum per tier
    4. schema         — strict Pydantic validation
    5. intent         — assertive_chat / self_disclosure / correction allowed
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Iterable

from pydantic import ValidationError

from lokidoki.orchestrator.memory.candidate import MemoryCandidate
from lokidoki.orchestrator.memory.predicates import (
    is_tier4_predicate,
    is_tier5_predicate,
)


class GateName(str, Enum):
    CLAUSE_SHAPE = "clause_shape"
    SUBJECT = "subject"
    PREDICATE = "predicate"
    SCHEMA = "schema"
    INTENT = "intent"


@dataclass(frozen=True)
class GateResult:
    """Outcome of a single gate evaluation."""

    gate: GateName
    passed: bool
    reason: str = ""


@dataclass(frozen=True)
class GateChainResult:
    """Outcome of running the full gate chain on a candidate."""

    accepted: bool
    failed_at: GateName | None
    results: tuple[GateResult, ...]


# ---------------------------------------------------------------------------
# Gate 1 — clause shape (parse-tree non-interrogative)
# ---------------------------------------------------------------------------

# Closed whitelist of info-request lemmas that turn an imperative-shaped
# sentence into a question-shaped one. Per design §3 Gate 1.
_INFO_REQUEST_LEMMAS: frozenset[str] = frozenset(
    {"tell", "explain", "show", "list", "find", "search", "look", "describe", "define"}
)

# WH-token tags from spaCy: WP (who/what/whom), WP$ (whose), WRB (where/when/why/how),
# WDT (which/that as determiner). Sentence-initial occurrence is the strongest signal
# of a question.
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
    """True if there's a sentence-leading aux/copula before any nominal subject.

    Catches polar questions like "is the president …", "are you …",
    "does she …", "did they …" without firing on declaratives like
    "the president is in Washington".
    """
    saw_aux = False
    for token in tokens:
        if getattr(token, "is_punct", False) or getattr(token, "is_space", False):
            continue
        dep = getattr(token, "dep_", "")
        tag = getattr(token, "tag_", "")
        # First non-trivial token is an aux/copula → polar question.
        if dep in {"aux", "auxpass"} or tag in {"MD"}:
            saw_aux = True
            return True
        # Otherwise the first token is something else → declarative shape.
        # We never reach the inversion case.
        return False
    return saw_aux


def _info_request_imperative(tokens: list[Any]) -> bool:
    """True if the sentence is an info-request imperative ('tell me about …').

    The root verb's lemma must be in the closed whitelist AND there must
    be no first-person nominal subject. 'tell me about Luke' fires
    (no nominal subject); 'I tell jokes' does not (subject 'I' present).
    """
    root = next((tok for tok in tokens if getattr(tok, "dep_", "") == "ROOT"), None)
    if root is None:
        return False
    lemma = getattr(root, "lemma_", "").lower()
    if lemma not in _INFO_REQUEST_LEMMAS:
        return False
    # If the root has a nominal subject other than implicit-you, it's a
    # declarative not an imperative. spaCy marks imperative subjects via
    # absence of an nsubj or via dep_=nsubj with PRON 'you' (rare).
    has_real_subject = any(
        getattr(child, "dep_", "") == "nsubj"
        and getattr(child, "lower_", "") not in {"you", ""}
        for child in getattr(root, "children", [])
    )
    return not has_real_subject


def gate_clause_shape(
    candidate: MemoryCandidate,
    parse_doc: Any,
) -> GateResult:
    """Gate 1 — non-interrogative parse-tree check.

    The chunk that produced the candidate must be **non-interrogative and
    non-info-request**. Allows fragments, imperative self-statements,
    and exclamatives per design §3 Gate 1 v1.1.
    """
    if parse_doc is None:
        # Without a parse tree we can only do the cheap text check.
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
        if _has_question_mark(sent_text) and _wh_fronted(tokens):
            return GateResult(
                GateName.CLAUSE_SHAPE,
                passed=False,
                reason="wh_fronted_question",
            )
        if _wh_fronted(tokens):
            return GateResult(
                GateName.CLAUSE_SHAPE,
                passed=False,
                reason="wh_fronted",
            )
        if _subject_aux_inversion(tokens) and _has_question_mark(sent_text):
            return GateResult(
                GateName.CLAUSE_SHAPE,
                passed=False,
                reason="subject_aux_inversion",
            )
        if _info_request_imperative(tokens):
            return GateResult(
                GateName.CLAUSE_SHAPE,
                passed=False,
                reason="info_request_imperative",
            )

    if _has_question_mark(candidate.source_text):
        # A bare "?" with no WH-fronting and no inversion is unusual but
        # still question-shaped (e.g. "really?", "tomorrow?"). Deny.
        return GateResult(
            GateName.CLAUSE_SHAPE,
            passed=False,
            reason="trailing_question_mark",
        )

    return GateResult(GateName.CLAUSE_SHAPE, passed=True)


# ---------------------------------------------------------------------------
# Gate 2 — subject identity
# ---------------------------------------------------------------------------


# Identity-establishing predicates can introduce a new person on the
# first mention — that's how Tier 5 rows are born. Gate 2 allows
# `person:X` candidates with one of these predicates even when X isn't
# already resolved; the writer creates the row. For non-identity
# predicates (like `lives_in` or `prefers` on someone else), the
# subject must resolve to an existing person to prevent garbage rows
# like `(person:the president, lives_in, DC)`.
_IDENTITY_ESTABLISHING_PREDICATES: frozenset[str] = frozenset(
    {"is_relation", "is_named", "has_pronoun"}
)


def gate_subject(
    candidate: MemoryCandidate,
    resolved_people: Iterable[str] | None = None,
    *,
    known_entities: Iterable[str] | None = None,
) -> GateResult:
    """Gate 2 — subject must be self / resolved person / handle / new
    person under an identity-establishing predicate / known entity.

    The intent of Gate 2 (per design §3 v1.1) is to block public
    figures, strangers, and hypothetical people while allowing
    private people in the user's life — including the **first
    mention** of a new family member or friend. M3 makes this
    distinction explicit: ``person:Luke`` paired with predicate
    ``is_relation`` means "Luke is being introduced as a relation",
    which is exactly the row creation event. Without this carve-out
    Gate 2 would deadlock the chicken-and-egg of social writes.
    """
    subject = candidate.subject
    if subject == "self":
        return GateResult(GateName.SUBJECT, passed=True, reason="self")

    if subject.startswith("handle:"):
        # Provisional handles are first-class — design §2 Tier 5 v1.1.
        return GateResult(GateName.SUBJECT, passed=True, reason="provisional_handle")

    if subject.startswith("person:"):
        name = subject.split(":", 1)[1].strip()
        if not name:
            return GateResult(GateName.SUBJECT, passed=False, reason="empty_person_name")
        # Public-figure / stranger guard. The set is intentionally tiny
        # and matches on the canonical *name* the extractor produced,
        # not on user input. Adding entries requires a corpus case.
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
                GateName.SUBJECT,
                passed=True,
                reason="new_person_via_identity_predicate",
            )
        return GateResult(
            GateName.SUBJECT,
            passed=False,
            reason="unresolved_person",
        )

    if subject.startswith("entity:"):
        name = subject.split(":", 1)[1].strip().lower()
        known = {n.lower() for n in (known_entities or [])}
        if name in known:
            return GateResult(GateName.SUBJECT, passed=True, reason="known_entity")
        return GateResult(
            GateName.SUBJECT,
            passed=False,
            reason="unknown_entity",
        )

    return GateResult(GateName.SUBJECT, passed=False, reason="unknown_subject_shape")


# Public-figure / stranger guard set. We use a *closed* lower-cased set
# of canonical generic-public phrases the extractor might produce. This
# is matched against the extractor's structured ``name`` argument, not
# against user input — the user could say "the president" and the
# extractor's parse-tree pattern would produce ``person:the president``,
# at which point this guard fires.
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


# ---------------------------------------------------------------------------
# Gate 3 — predicate validity
# ---------------------------------------------------------------------------


def gate_predicate(candidate: MemoryCandidate) -> GateResult:
    """Gate 3 — predicate is in the Tier 4 OR Tier 5 closed enum.

    The classifier in Layer 2 picks the actual tier; Gate 3 only checks
    the predicate is *somewhere* in the union of valid predicates.
    """
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
    """Gate 4 — strict Pydantic validation. No repair loop.

    Accepts a dict OR an already-validated MemoryCandidate. Returns a
    tuple of (gate-result, validated-candidate-or-None) so the caller
    can use the validated object directly without re-parsing.
    """
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

# Allowed intents per design §3 Gate 5 v1.1. Conversation is the
# *primary* write surface; we deny only on non-assertive intents.
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
    """Gate 5 — intent label gates the write.

    If the decomposer cannot label intent confidently (None), this gate
    falls through and trusts Gate 1's clause-shape check. The two gates
    are deliberately redundant per design §3 — defense in depth.
    """
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
    # Unknown intent label — fall through. The decomposer's intent
    # vocabulary may evolve; we don't want a typo to silently block
    # writes. Gate 1 still applied.
    return GateResult(GateName.INTENT, passed=True, reason="unknown_intent_pass_through")


# ---------------------------------------------------------------------------
# Chain runner
# ---------------------------------------------------------------------------


def run_gate_chain(
    raw_candidate: Any,
    *,
    parse_doc: Any = None,
    resolved_people: Iterable[str] | None = None,
    known_entities: Iterable[str] | None = None,
    decomposed_intent: str | None = None,
) -> GateChainResult:
    """Run all five gates in order, short-circuiting on the first failure.

    The order is intentional: cheap structural checks first (Gate 1
    works on the parse tree we already have), strict validation in the
    middle (Gate 4 might allocate a Pydantic model), intent last (it's
    the cheapest but also the least authoritative).
    """
    results: list[GateResult] = []

    # Gate 4 first if we got a raw dict — we need a validated candidate
    # to feed the other gates. But we run Gate 4 INSIDE the chain so its
    # result still appears in the trace.
    schema_result, candidate = gate_schema(raw_candidate)
    if not schema_result.passed:
        return GateChainResult(
            accepted=False,
            failed_at=GateName.SCHEMA,
            results=(schema_result,),
        )

    # We have a validated candidate. Now run gates 1 → 5 (excluding 4).
    g1 = gate_clause_shape(candidate, parse_doc)
    results.append(g1)
    if not g1.passed:
        return GateChainResult(False, GateName.CLAUSE_SHAPE, tuple(results))

    g2 = gate_subject(candidate, resolved_people, known_entities=known_entities)
    results.append(g2)
    if not g2.passed:
        return GateChainResult(False, GateName.SUBJECT, tuple(results))

    g3 = gate_predicate(candidate)
    results.append(g3)
    if not g3.passed:
        return GateChainResult(False, GateName.PREDICATE, tuple(results))

    # Gate 4 already passed — record it for the trace.
    results.append(schema_result)

    g5 = gate_intent(candidate, decomposed_intent)
    results.append(g5)
    if not g5.passed:
        return GateChainResult(False, GateName.INTENT, tuple(results))

    return GateChainResult(accepted=True, failed_at=None, results=tuple(results))
