"""Tests for ``lokidoki.orchestrator.response.status_strings`` (chunk 15).

The map is a contract between the pipeline emitter and the frontend
``StatusBlock`` renderer — both sides assume the same phase keys. We
lock in:

* Every canonical phase the pipeline emits has a short, jargon-free
  phrase.
* Phrases obey the design doc's "good / bad status text" guidance
  (design §22): no internal jargon, no trailing ellipsis, reasonably
  short.
* Unknown phases return ``None`` so the caller can leave the previous
  phrase in place.
* The ``FINISHING_PHRASE`` neutral fallback exists and is non-empty.
"""
from __future__ import annotations

import pytest

from lokidoki.orchestrator.response import status_strings


# Keys the pipeline is contractually required to know how to patch.
# If you add/remove a row here you MUST also update
# ``STATUS_BY_PHASE`` in :mod:`lokidoki.orchestrator.response.status_strings`.
_EXPECTED_PHASES: tuple[str, ...] = (
    "augmentation",
    "decomposition",
    "routing",
    "execute",
    "media_augment",
    "synthesis",
)


def test_every_expected_phase_has_a_phrase() -> None:
    for phase in _EXPECTED_PHASES:
        phrase = status_strings.phrase_for(phase)
        assert phrase is not None, f"missing status phrase for phase {phase!r}"
        assert phrase.strip() == phrase, f"phrase {phrase!r} has stray whitespace"
        assert phrase, f"phrase for {phase!r} is empty"


def test_all_phases_returns_canonical_tuple() -> None:
    # Guards the planner + pipeline emitter against silent drift. If
    # you add a phase, extend both constants.
    assert status_strings.all_phases() == _EXPECTED_PHASES


def test_unknown_phase_returns_none() -> None:
    assert status_strings.phrase_for("does_not_exist") is None
    assert status_strings.phrase_for("") is None


def test_finishing_phrase_is_populated() -> None:
    # Pipeline patches this when a block fails — must never be empty,
    # must read human.
    assert status_strings.FINISHING_PHRASE
    assert status_strings.FINISHING_PHRASE.strip() == status_strings.FINISHING_PHRASE


@pytest.mark.parametrize("phase", list(_EXPECTED_PHASES))
def test_phrases_are_jargon_free(phase: str) -> None:
    # "Good" design-doc phrasings lead with a verb in -ing form and
    # never include engineering jargon. This isn't an exhaustive
    # lint — it's a tripwire so we don't accidentally ship
    # "routing_complete" or "augmentation_done" as user-facing text.
    phrase = status_strings.phrase_for(phase)
    assert phrase is not None
    lowered = phrase.lower()
    banned_tokens = ("augmentation", "decomposition", "synthesis", "mechanism", "_")
    for banned in banned_tokens:
        assert banned not in lowered, (
            f"phrase {phrase!r} for phase {phase!r} contains jargon token {banned!r}"
        )
    # Short, single sentence — hard cap so a long internal trace step
    # name doesn't sneak into the UI.
    assert len(phrase) <= 40, f"phrase {phrase!r} is too long ({len(phrase)} chars)"


def test_status_by_phase_matches_phrase_for() -> None:
    # Public API + raw dict stay in sync.
    for phase, phrase in status_strings.STATUS_BY_PHASE.items():
        assert status_strings.phrase_for(phase) == phrase
