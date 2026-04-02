"""Base skill contract."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseSkill(ABC):
    """Small base class for installable LokiDoki skills."""

    manifest: dict[str, Any]

    @abstractmethod
    async def execute(self, action: str, ctx: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        """Execute one skill action."""

    async def test_connection(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """Run a read-only integration test when the skill supports it."""
        raise NotImplementedError("This skill does not support connection testing.")

    def validate_action(self, action: str) -> None:
        """Ensure the requested action exists in the manifest."""
        actions = self.manifest.get("actions", {})
        if action not in actions:
            raise ValueError(f"Unknown action: {action}")
