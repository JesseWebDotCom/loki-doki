"""
Layer 2 — tier classifier.

Routes a candidate that has *already* passed Layer 1 (gates) into one of
the writable tiers: semantic_self (4), social (5), session (2), episodic
(3), emotional (6), procedural (7).

The classifier is a **router**, not a gatekeeper. It cannot deny — Layer 1
already approved the write. It only picks the destination.

Phase status: M1 — deterministic ruleset only. The constrained-decoding
small-model variant from §8 M1 deliverable 2 is deferred to a follow-up
bake-off; the deterministic ruleset is the safer default per §10 question 1.

The rules:

    subject == self                    → tier 4 (semantic_self)
    subject == person:* / handle:*     → tier 5 (social)
    subject == entity:*                → tier 4 (semantic_self), since
                                          entity ownership/constraint
                                          predicates are about the user

Tiers 2/3/6/7 are observation-only or behavior-derived in M1 and don't
receive write candidates from this classifier; they're populated in
their own milestones (M4, M6, M5).
"""
from __future__ import annotations

from dataclasses import dataclass

from v2.orchestrator.memory.candidate import MemoryCandidate
from v2.orchestrator.memory.predicates import is_tier4_predicate, is_tier5_predicate
from v2.orchestrator.memory.tiers import Tier


@dataclass(frozen=True)
class ClassificationResult:
    target_tier: Tier | None
    confidence: float
    reason: str


def classify_candidate(candidate: MemoryCandidate) -> ClassificationResult:
    """Pick the destination tier for an already-gated candidate."""
    subject = candidate.subject
    predicate = candidate.predicate

    if subject == "self" or subject.startswith("entity:"):
        if is_tier4_predicate(predicate):
            return ClassificationResult(Tier.SEMANTIC_SELF, 1.0, "self_predicate_tier4")
        # Predicate is in Tier 5 enum but subject is self → Tier 4
        # because the user is the subject. Example: 'self has_pronoun
        # they' is a Tier 4 fact about the user, not a social row.
        return ClassificationResult(Tier.SEMANTIC_SELF, 0.8, "self_fallback_tier4")

    if subject.startswith("person:") or subject.startswith("handle:"):
        if is_tier5_predicate(predicate):
            return ClassificationResult(Tier.SOCIAL, 1.0, "social_predicate_tier5")
        # Person subject with a Tier 4 predicate (e.g. preferences about
        # another person). Tier 5 still wins because the row is about a
        # person.
        return ClassificationResult(Tier.SOCIAL, 0.8, "person_fallback_tier5")

    return ClassificationResult(None, 0.0, "no_match")
