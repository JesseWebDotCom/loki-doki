"""Shared response-adapter types."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from lokidoki.core.skill_executor import MechanismResult


@dataclass(frozen=True, slots=True)
class Source:
    title: str
    url: str | None = None
    kind: str = "web"
    snippet: str | None = None
    page: int | None = None
    published_at: str | None = None
    author: str | None = None
    relevance: float | None = None


@dataclass(frozen=True, slots=True)
class AdapterOutput:
    summary_candidates: tuple[str, ...] = ()
    facts: tuple[str, ...] = ()
    sources: tuple[Source, ...] = ()
    media: tuple[dict[str, Any], ...] = ()
    actions: tuple[dict[str, Any], ...] = ()
    artifact_candidates: tuple[dict[str, Any], ...] = ()
    follow_up_candidates: tuple[str, ...] = ()
    raw: dict[str, Any] | None = None


class SkillAdapter(Protocol):
    skill_id: str

    def adapt(self, result: MechanismResult) -> AdapterOutput:
        """Normalize one successful mechanism result."""
        ...
