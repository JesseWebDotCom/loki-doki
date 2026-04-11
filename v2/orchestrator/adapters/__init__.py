"""Local-data adapters for the v2 prototype.

Each adapter exposes a small, deterministic interface that resolvers can
call without knowing whether the underlying source is a real database, a
Home Assistant REST endpoint, or an in-memory stub. The prototype ships
in-memory stubs so the pipeline can be exercised end-to-end before any
external services are wired up.
"""
from __future__ import annotations

from v2.orchestrator.adapters.conversation_memory import ConversationMemoryAdapter
from v2.orchestrator.adapters.home_assistant import HomeAssistantAdapter
from v2.orchestrator.adapters.loki_people_db import LokiPeopleDBAdapter
from v2.orchestrator.adapters.loki_smarthome import LokiSmartHomeAdapter
from v2.orchestrator.adapters.movie_context import MovieContextAdapter
from v2.orchestrator.adapters.people_db import PeopleDBAdapter

__all__ = [
    "ConversationMemoryAdapter",
    "HomeAssistantAdapter",
    "LokiPeopleDBAdapter",
    "LokiSmartHomeAdapter",
    "MovieContextAdapter",
    "PeopleDBAdapter",
]
