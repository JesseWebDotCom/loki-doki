"""Skill adapters for the pipeline.

Each module in this package is a thin async wrapper around a LokiDoki
skill backend living under ``lokidoki/skills/``. The wrapper:

  1. Holds a process-singleton instance of the skill class.
  2. Translates the executor payload (``{"chunk_text", "params", ...}``)
     into the mechanism call signature.
  3. Walks the fallback chain (e.g. live API → local cache) and
     returns the handler shape ``{"output_text": str, ...}``.

CLAUDE.md scope rule: this package only IMPORTS from ``lokidoki.skills.*``
— it never modifies skill code. The pipeline stays self-contained while
re-using the proven backends, fallbacks, and caching.

Skill modules expose a single public ``handle(payload)`` async function
which is registered in ``lokidoki/orchestrator/execution/executor.py``.
"""
from __future__ import annotations

__all__: list[str] = []
