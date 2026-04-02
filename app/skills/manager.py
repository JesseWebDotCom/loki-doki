"""Execution manager for skill actions."""

from __future__ import annotations

import asyncio
import sqlite3
from typing import Any

from app.skills.loader import SkillLoader
from app.skills.response import build_skill_render_payload, build_skill_reply
from . import storage as storage_module
from app.skills.types import InstalledSkillRecord, RouteDecision, SkillExecutionResult


class SkillManager:
    """Resolve, execute, and post-process skill calls."""

    def __init__(self, loader: SkillLoader):
        self._loader = loader

    def execute(
        self,
        conn: sqlite3.Connection,
        record: InstalledSkillRecord,
        route: RouteDecision,
        runtime_context: dict[str, Any],
        request_text: str,
        database_path: str,
        turn_id: str = "",
    ) -> SkillExecutionResult:
        """Execute one routed skill action."""
        if route.candidate is None:
            raise ValueError("Cannot execute a route without a candidate.")
        skill = self._loader.load(record)
        shared_context = dict(runtime_context.get("shared_contexts", {}).get(record.skill_id, {}))
        payload = {
            **shared_context,
            "user_id": runtime_context["user_id"],
            "username": runtime_context["username"],
            "display_name": runtime_context["display_name"],
            "profile": runtime_context["profile"],
            "accounts": runtime_context["accounts"],
            "request_text": request_text,
            "database_path": database_path,
        }
        result = asyncio.run(skill.execute(route.candidate.action, payload, **route.candidate.extracted_entities))
        reply, card = build_skill_reply(result)
        render_payload = build_skill_render_payload(result, reply, card, route.to_dict())
        storage_module.touch_skill_last_used(conn, record.skill_id)
        return SkillExecutionResult(
            ok=bool(result.get("ok", False)),
            skill_id=record.skill_id,
            action=route.candidate.action,
            route=route,
            result=result,
            reply=reply,
            card=card,
            meta={
                "request_type": "skill_call",
                "route": f"{record.skill_id}.{route.candidate.action}",
                "reason": route.reason,
                "execution": {
                    "provider": record.skill_id,
                    "backend": "skill_runtime",
                    "model": record.version,
                    "acceleration": "cpu",
                },
                "render_payload": render_payload,
                "turn_id": turn_id,
                "voice_summary": str(render_payload.get("voice_summary") or reply).strip(),
            },
        )
