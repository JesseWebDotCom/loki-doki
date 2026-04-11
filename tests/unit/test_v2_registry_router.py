from __future__ import annotations

from v2.bmo_nlu.registry.builder import build_router_index
from v2.bmo_nlu.registry.runtime import get_runtime
from v2.bmo_nlu.routing.router import route_chunk
from v2.bmo_nlu.core.types import RequestChunk


def test_v2_runtime_loads_capability_registry():
    runtime = get_runtime()

    assert runtime.capabilities
    assert "greeting_response" in runtime.capabilities
    assert "spell_word" in runtime.capabilities


def test_v2_builder_precomputes_vectors_at_startup():
    items = [
        {
            "capability": "get_current_time",
            "description": "Tell the user the current local time.",
            "examples": ["what time is it"],
            "enabled": True,
        }
    ]

    def fake_embed(texts: list[str]) -> list[list[float]]:
        return [[float(len(text)), float(index)] for index, text in enumerate(texts)]

    index = build_router_index(items, embed_texts=fake_embed)

    assert index[0]["capability"] == "get_current_time"
    assert index[0]["texts"] == [
        "tell the user the current local time.",
        "what time is it",
    ]
    assert index[0]["vectors"] == [[37.0, 0.0], [15.0, 1.0]]
    assert index[0]["vector_dim"] == 2


def test_v2_router_uses_registry_backed_similarity():
    runtime = get_runtime()
    chunk = RequestChunk(text="what's the time", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "get_current_time"
    assert match.confidence > 0.6
    assert match.matched_text == "what's the time"


def test_v2_router_handles_spelling_phrase_variant():
    runtime = get_runtime()
    chunk = RequestChunk(text="spell restaurant", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "spell_word"
    assert "spell" in match.matched_text


def test_v2_router_prefers_prebuilt_vector_similarity_over_lexical_match():
    class StubRuntime:
        router_index = [
            {
                "capability": "set_timer",
                "texts": ["set a timer"],
                "vectors": [[0.0, 1.0]],
                "vector_dim": 2,
            },
            {
                "capability": "get_current_time",
                "texts": ["what time is it"],
                "vectors": [[1.0, 0.0]],
                "vector_dim": 2,
            },
        ]

        def embed_query(self, text: str) -> list[float]:
            assert text == "clock please"
            return [1.0, 0.0]

    chunk = RequestChunk(text="clock please", index=0)

    match = route_chunk(chunk, StubRuntime())

    assert match.capability == "get_current_time"
    assert match.confidence == 1.0
    assert match.matched_text == "what time is it"
