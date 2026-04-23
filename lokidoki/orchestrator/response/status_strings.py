"""Phase → status-phrase map for the live ``status`` block.

Chunk 15 of the rich-response rollout (see
``docs/rich-response/chunk-15-blocks-meta.md``).

The pipeline emits ``block_patch`` updates to the envelope's ``status``
block at phase transitions so the UI can show a single line of live
activity text ("checking sources", "looking for visuals") that is
distinct from the detailed trace popover. Rules:

* Entries are short, human, and jargon-free (design doc §22 — avoid
  "routing complete", use "picking the right skills").
* No regex or LLM routing here — the pipeline calls :func:`phrase_for`
  with a canonical phase key the caller already knows.
* The ``status`` block is live-only. On ``response_done`` the caller
  flips it to :data:`BlockState.omitted` so it disappears once the
  final answer lands.
* On a block failure (any ``block_failed`` emission inside the turn)
  the caller patches the status line to :data:`FINISHING_PHRASE` — the
  design doc is explicit that we don't double-report errors; the UI
  already surfaces failure on the actual failing block.

When a caller passes a phase that isn't mapped, :func:`phrase_for`
returns ``None`` so the caller can decide to leave the previous phrase
in place (no accidental "" flashes).
"""
from __future__ import annotations

# Canonical phase → phrase map.
#
# Keys here MUST match the ``phase_key`` strings
# :func:`lokidoki.orchestrator.core.pipeline_phases.emit_status_patch`
# passes at phase transitions. Keep this list minimal — one phrase per
# user-visible phase. The pipeline itself has more granular steps
# (parse / split / extract …) which all roll up into the
# "decomposition" bucket per ``streaming._STEP_TO_PHASE``.
STATUS_BY_PHASE: dict[str, str] = {
    "augmentation": "Looking up context",
    "decomposition": "Understanding your ask",
    "routing": "Picking the right skills",
    "execute": "Checking sources",
    "media_augment": "Looking for visuals",
    "synthesis": "Preparing response",
}

# Neutral phrase the caller patches in when any block on the turn
# fails — the status line should not dwell on errors.
FINISHING_PHRASE: str = "Finishing up"


def phrase_for(phase_key: str) -> str | None:
    """Return the human-readable status phrase for ``phase_key``.

    Returns ``None`` for unknown phases so the caller can leave the
    previous phrase in place rather than overwriting it with an empty
    string. Matching is exact — keys are canonical, not normalized.
    """
    if not phase_key:
        return None
    return STATUS_BY_PHASE.get(phase_key)


def all_phases() -> tuple[str, ...]:
    """Return the ordered tuple of known phase keys.

    Exposed for the unit test so the contract between the pipeline
    emitter and the phrase map stays locked.
    """
    return tuple(STATUS_BY_PHASE.keys())


__all__ = [
    "STATUS_BY_PHASE",
    "FINISHING_PHRASE",
    "phrase_for",
    "all_phases",
]
