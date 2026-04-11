"""v2 jokes adapter — wraps lokidoki.skills.jokes (icanhazdadjoke)."""
from __future__ import annotations

from typing import Any

from lokidoki.skills.jokes.skill import JokesSkill

from v2.orchestrator.skills._runner import AdapterResult, run_mechanisms

_SKILL = JokesSkill()


def _format_success(result, method: str) -> str:
    data = result.data or {}
    return str(data.get("joke") or "I forgot the punchline.").strip()


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    attempts = [("icanhazdadjoke", {})]
    result = await run_mechanisms(
        _SKILL,
        attempts,
        on_success=_format_success,
        on_all_failed="I couldn't reach the joke service right now — try again in a sec.",
    )
    return result.to_payload()
