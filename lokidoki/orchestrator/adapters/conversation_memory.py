"""Conversation memory adapter for the pipeline.

Reads recent entities, the last referenced entity, and short-term context
hints from a request-scoped ``context`` dict so the resolver can fill in
pronouns ("it", "that movie") deterministically.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(slots=True)
class RecentEntity:
    name: str
    entity_type: str
    metadata: dict[str, Any]


class ConversationMemoryAdapter:
    """Thin reader over the request ``context`` dict."""

    def __init__(self, context: dict[str, Any] | None = None) -> None:
        self._context = context or {}

    @property
    def context(self) -> dict[str, Any]:
        return self._context

    def recent_entities(self, *, entity_type: str | None = None) -> list[RecentEntity]:
        entities: list[RecentEntity] = []
        for raw in self._iter_recent():
            if not isinstance(raw, dict):
                continue
            etype = str(raw.get("type") or "").lower()
            if entity_type and etype != entity_type:
                continue
            name = str(raw.get("name") or "").strip()
            if not name:
                continue
            entities.append(
                RecentEntity(
                    name=name,
                    entity_type=etype,
                    metadata={k: v for k, v in raw.items() if k not in {"type", "name"}},
                )
            )
        return entities

    def last_entity(self, entity_type: str | None = None) -> RecentEntity | None:
        entities = self.recent_entities(entity_type=entity_type)
        return entities[0] if entities else None

    def _iter_recent(self) -> Iterable[Any]:
        raw = self._context.get("recent_entities")
        if isinstance(raw, list):
            yield from raw
