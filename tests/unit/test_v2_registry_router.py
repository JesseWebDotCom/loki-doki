from __future__ import annotations

from v2.bmo_nlu.registry.runtime import get_runtime
from v2.bmo_nlu.routing.router import route_chunk
from v2.bmo_nlu.core.types import RequestChunk


def test_v2_runtime_loads_capability_registry():
    runtime = get_runtime()

    assert runtime.capabilities
    assert "greeting_response" in runtime.capabilities
    assert "spell_word" in runtime.capabilities


def test_v2_router_uses_registry_backed_similarity():
    runtime = get_runtime()
    chunk = RequestChunk(text="what's the time", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "get_current_time"
    assert match.confidence > 0.6


def test_v2_router_handles_spelling_phrase_variant():
    runtime = get_runtime()
    chunk = RequestChunk(text="spell restaurant", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "spell_word"
