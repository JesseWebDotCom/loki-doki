"""Offline-first travel adapters — thin re-export facade.

The implementations live in per-capability modules:
``travel_flights``, ``travel_hotels``, ``travel_visa``, ``travel_transit``.
This module re-exports all four public functions so existing imports
(``from lokidoki.orchestrator.skills.travel_local import search_flights``)
continue to work unchanged.
"""
from lokidoki.orchestrator.skills.travel_flights import search_flights
from lokidoki.orchestrator.skills.travel_hotels import search_hotels
from lokidoki.orchestrator.skills.travel_transit import get_transit
from lokidoki.orchestrator.skills.travel_visa import get_visa_info

__all__ = ["search_flights", "search_hotels", "get_visa_info", "get_transit"]
