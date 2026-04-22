"""Deep-work path — dedicated async pipeline for ``deep`` mode turns.

Chunk 18 of the rich-response rollout (see
``docs/rich-response/chunk-18-deep-mode.md``).

Design doc §10.4 spells out the contract enforced by this package:

* Deep mode is **explicit user opt-in only** — the decomposer may
  *suggest* it but must never auto-escalate an ordinary ask. The mode
  planner honours this via
  :mod:`lokidoki.orchestrator.response.mode` (``deep_opt_in=True``
  required) and Chunk 13 wires the compose-bar toggle / ``/deep``
  slash.
* A **hard wall-clock cap** per profile guards against a 4B local
  model stalling for minutes. On timeout, the runner materializes the
  partial envelope as-is and flips every populated block to
  ``ready``.
* **Checkpointed writes** — every stage transition calls the optional
  ``_deep_checkpoint`` callback on ``safe_context`` so a client
  disconnect doesn't lose the in-progress turn.
* **Single concurrent deep turn per session** — :class:`DeepGate`
  rejects a second request with a clarification block instead of
  queuing silently.
* **Dedicated async task** — the runner accepts its own inputs and
  returns an upgraded envelope; the pipeline layer branches into it
  after synthesis finishes the fast first-answer pass.

The package is deliberately small: gate + stages + runner. Everything
else (routing, execution, synthesis) reuses the standard pipeline
components — deep mode does NOT reimplement them.
"""
from __future__ import annotations

from lokidoki.orchestrator.deep.gate import DeepGate
from lokidoki.orchestrator.deep.runner import (
    DeepRunResult,
    WALL_CLOCK_SECONDS,
    run_deep_turn,
)
from lokidoki.orchestrator.deep.stages import (
    DeepStageEvent,
    DeepStageHooks,
    DeepStageName,
    dedupe_sources,
    default_hooks,
    expand_ask,
    finalize_blocks,
    gather_evidence,
    progressive_summary,
)

__all__ = [
    "DeepGate",
    "DeepRunResult",
    "DeepStageEvent",
    "DeepStageHooks",
    "DeepStageName",
    "WALL_CLOCK_SECONDS",
    "dedupe_sources",
    "default_hooks",
    "expand_ask",
    "finalize_blocks",
    "gather_evidence",
    "progressive_summary",
    "run_deep_turn",
]
