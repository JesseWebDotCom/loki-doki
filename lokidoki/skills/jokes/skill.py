"""Jokes skill — icanhazdadjoke (free, no key, family-friendly)."""
from __future__ import annotations

import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

URL = "https://icanhazdadjoke.com/"


class JokesSkill(BaseSkill):
    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method != "icanhazdadjoke":
            raise ValueError(f"Unknown mechanism: {method}")
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                resp = await client.get(
                    URL,
                    headers={"Accept": "application/json", "User-Agent": "LokiDoki/0.2"},
                )
        except httpx.HTTPError as exc:
            return MechanismResult(success=False, error=f"network error: {exc}")
        if resp.status_code != 200:
            return MechanismResult(success=False, error=f"http {resp.status_code}")
        try:
            payload = resp.json()
        except ValueError:
            return MechanismResult(success=False, error="malformed response")
        joke = (payload.get("joke") or "").strip()
        if not joke:
            return MechanismResult(success=False, error="empty joke")
        return MechanismResult(
            success=True,
            data={"joke": joke},
            source_url="https://icanhazdadjoke.com/",
            source_title="icanhazdadjoke",
        )
