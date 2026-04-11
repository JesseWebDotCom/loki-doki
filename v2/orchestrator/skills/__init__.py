"""Skill adapters for the v2 prototype.

Each module in this package is a thin async wrapper around an existing v1
LokiDoki skill living under ``lokidoki/skills/``. The wrapper:

  1. Holds a process-singleton instance of the v1 skill class.
  2. Translates the v2 executor payload (``{"chunk_text", "params", ...}``)
     into the v1 mechanism call signature.
  3. Walks the v1 fallback chain (e.g. live API → local cache) and
     returns the v2 handler shape ``{"output_text": str, ...}``.

CLAUDE.md scope rule: this package only IMPORTS from ``lokidoki.skills.*``
— it never modifies v1 code. The v2 prototype stays self-contained while
re-using the proven v1 backends, fallbacks, and caching.

Skill modules expose a single public ``handle(payload)`` async function
which is registered in ``v2/orchestrator/execution/executor.py``.
"""
from __future__ import annotations

__all__: list[str] = []
