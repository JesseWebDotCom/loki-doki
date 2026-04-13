"""Local-data adapters for the pipeline.

Each adapter exposes a small, deterministic interface that resolvers can
call without knowing whether the underlying source is a real database, a
Home Assistant REST endpoint, or an in-memory stub. The prototype ships
in-memory stubs so the pipeline can be exercised end-to-end before any
external services are wired up.
"""
from __future__ import annotations

from lokidoki.orchestrator.adapters.conversation_memory import ConversationMemoryAdapter
from lokidoki.orchestrator.adapters.home_assistant import HomeAssistantAdapter
from lokidoki.orchestrator.adapters.loki_people_db import LokiPeopleDBAdapter
from lokidoki.orchestrator.adapters.loki_smarthome import LokiSmartHomeAdapter
from lokidoki.orchestrator.adapters.movie_context import MovieContextAdapter
from lokidoki.orchestrator.adapters.people_db import PeopleDBAdapter

__all__ = [
    "ConversationMemoryAdapter",
    "HomeAssistantAdapter",
    "LokiPeopleDBAdapter",
    "LokiSmartHomeAdapter",
    "MovieContextAdapter",
    "PeopleDBAdapter",
]
