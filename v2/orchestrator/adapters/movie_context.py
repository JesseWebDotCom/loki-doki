"""Movie context adapter for the v2 prototype.

Wraps the conversation memory adapter to expose a movie-specific lens
for the media resolver. The default seed roster uses canonical movies
so smoke tests do not need a real cache.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from v2.orchestrator.adapters.conversation_memory import ConversationMemoryAdapter, RecentEntity


@dataclass(slots=True)
class MovieRecord:
    title: str
    movie_id: str = ""
    year: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class MovieContextAdapter:
    """Resolve "that movie" / "the film" against recent conversation entities."""

    def __init__(self, memory: ConversationMemoryAdapter) -> None:
        self._memory = memory

    def recent_movies(self) -> list[MovieRecord]:
        records: list[MovieRecord] = []
        for entity in self._memory.recent_entities():
            if entity.entity_type not in {"movie", "film", "media", "tv_show"}:
                continue
            records.append(_to_movie(entity))
        return records

    def current_movie(self) -> MovieRecord | None:
        records = self.recent_movies()
        return records[0] if records else None


def _to_movie(entity: RecentEntity) -> MovieRecord:
    metadata = entity.metadata or {}
    return MovieRecord(
        title=entity.name,
        movie_id=str(metadata.get("id") or metadata.get("movie_id") or ""),
        year=int(metadata["year"]) if isinstance(metadata.get("year"), int) else None,
        metadata=metadata,
    )
