"""Adapter exports for resolvers and response normalization.

This package now serves two roles:

- resolver/data adapters used by the routing + resolution pipeline
- response adapters that normalize skill payloads for rich responses
"""
from __future__ import annotations

from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.adapters.calculator import CalculatorAdapter
from lokidoki.orchestrator.adapters.conversation_memory import ConversationMemoryAdapter
from lokidoki.orchestrator.adapters.datetime_local import DateTimeAdapter
from lokidoki.orchestrator.adapters.dictionary import DictionaryAdapter
from lokidoki.orchestrator.adapters.document import DocumentAdapter
from lokidoki.orchestrator.adapters.home_assistant import HomeAssistantAdapter
from lokidoki.orchestrator.adapters.jokes import JokesAdapter
from lokidoki.orchestrator.adapters.knowledge import WikipediaAdapter
from lokidoki.orchestrator.adapters.loki_people_db import LokiPeopleDBAdapter
from lokidoki.orchestrator.adapters.loki_smarthome import LokiSmartHomeAdapter
from lokidoki.orchestrator.adapters.movie_context import MovieContextAdapter
from lokidoki.orchestrator.adapters.movies_fandango import FandangoShowtimesAdapter
from lokidoki.orchestrator.adapters.movies_tmdb import TMDBAdapter
from lokidoki.orchestrator.adapters.movies_wiki import WikiMoviesAdapter
from lokidoki.orchestrator.adapters.news import NewsAdapter
from lokidoki.orchestrator.adapters.people_db import PeopleDBAdapter
from lokidoki.orchestrator.adapters.people_lookup import PeopleLookupAdapter
from lokidoki.orchestrator.adapters.recipes import RecipeMealDBAdapter
from lokidoki.orchestrator.adapters.registry import adapt, register, resolve_adapter
from lokidoki.orchestrator.adapters.search import DuckDuckGoAdapter
from lokidoki.orchestrator.adapters.smarthome_mock import SmartHomeMockAdapter
from lokidoki.orchestrator.adapters.tvshows import TVMazeAdapter
from lokidoki.orchestrator.adapters.unit_conversion import UnitConversionAdapter
from lokidoki.orchestrator.adapters.weather_openmeteo import OpenMeteoAdapter
from lokidoki.orchestrator.adapters.youtube import YouTubeAdapter

register(CalculatorAdapter())
register(DateTimeAdapter())
register(DictionaryAdapter())
register(DocumentAdapter())
register(UnitConversionAdapter())
register(JokesAdapter())
register(WikipediaAdapter())
register(DuckDuckGoAdapter())
register(NewsAdapter())
register(OpenMeteoAdapter())
register(FandangoShowtimesAdapter())
register(TMDBAdapter())
register(WikiMoviesAdapter())
register(RecipeMealDBAdapter())
register(TVMazeAdapter())
register(PeopleLookupAdapter())
register(YouTubeAdapter())
register(SmartHomeMockAdapter())

__all__ = [
    "AdapterOutput",
    "ConversationMemoryAdapter",
    "DocumentAdapter",
    "Source",
    "HomeAssistantAdapter",
    "LokiPeopleDBAdapter",
    "LokiSmartHomeAdapter",
    "MovieContextAdapter",
    "PeopleDBAdapter",
    "adapt",
    "register",
    "resolve_adapter",
]
