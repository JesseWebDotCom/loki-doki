"""Built-in core memory extraction skill."""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from app.skills.base import BaseSkill
from app.subsystems.memory import store as memory_store


class CoreMemorySkill(BaseSkill):
    """Extract and persist long-term facts into the local SQLite node."""

    manifest: dict[str, Any] = {}

    async def execute(
        self,
        action: str,
        ctx: dict[str, Any],
        emit_progress: Callable[[str], Awaitable[None]],
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Execute the requested memory action."""
        self.validate_action(action)
        if action != "save_fact":
            raise ValueError(f"Unhandled action: {action}")
        
        key = str(kwargs.get("key", "")).strip()
        value = str(kwargs.get("value", "")).strip()
        category = str(kwargs.get("category", "user")).strip()
        confidence = float(kwargs.get("confidence", 0.9))
        
        user_id = ctx.get("user", {}).get("id", "default_user")
        
        # Depending on how the skill router executes, characters might not be present
        # This acts as a safe fallback
        character_id = ctx.get("character", {}).get("id", "lokidoki")
        
        written = memory_store.write_memory(
            conn=ctx["connection"],
            user_id=user_id,
            character_id=character_id,
            key=key,
            value=value,
            category=category,
            confidence=confidence,
            source="explicit" if confidence >= 1.0 else "extracted"
        )
        
        return {
            "ok": True,
            "skill": "core_memory",
            "action": "save_fact",
            "data": {"key": key, "value": value, "written": written},
            "meta": {"threshold_met": written, "confidence": confidence},
            "presentation": {"type": "memory_saved"},
            "errors": [],
        }
