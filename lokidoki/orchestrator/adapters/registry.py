"""Registry for rich-response skill adapters."""
from __future__ import annotations

import logging

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.base import AdapterOutput, SkillAdapter

logger = logging.getLogger("lokidoki.orchestrator.adapters.registry")

ADAPTERS: dict[str, SkillAdapter] = {}


def register(adapter: SkillAdapter) -> None:
    """Register a response adapter by skill id."""
    ADAPTERS[adapter.skill_id] = adapter


def resolve_adapter(skill_id: str) -> SkillAdapter | None:
    """Return the registered adapter for ``skill_id`` if present."""
    return ADAPTERS.get(skill_id)


def adapt(skill_id: str, result: MechanismResult) -> AdapterOutput:
    """Normalize a mechanism result without breaking legacy consumers."""
    adapter = resolve_adapter(skill_id)
    if adapter is None:
        return AdapterOutput(raw=result.data)
    try:
        return adapter.adapt(result)
    except Exception:  # noqa: BLE001 - adapter failures must stay additive
        logger.exception("response adapter failed for skill_id=%s", skill_id)
        return AdapterOutput(raw=result.data)
