from __future__ import annotations

from v2.orchestrator.registry.builder import build_router_index
from v2.orchestrator.registry.loader import load_function_registry
from v2.orchestrator.registry.runtime import get_runtime
from v2.orchestrator.routing.router import route_chunk
from v2.orchestrator.core.types import RequestChunk


def test_v2_runtime_loads_capability_registry():
    runtime = get_runtime()

    assert runtime.capabilities
    assert "greeting_response" in runtime.capabilities
    assert "spell_word" in runtime.capabilities


def test_v2_function_registry_has_parameters_and_mechanisms():
    """Every capability must declare a v1-style parameters dict and a
    mechanism chain so the executor / dev tools can introspect them."""
    entries = load_function_registry()
    assert entries, "function_registry.json is empty"

    missing_params: list[str] = []
    missing_mechanisms: list[str] = []
    for entry in entries:
        cap = entry["capability"]
        if "parameters" not in entry:
            missing_params.append(cap)
        if "mechanisms" not in entry or not entry["mechanisms"]:
            missing_mechanisms.append(cap)
        # Mechanism descriptors must follow the v1 BaseSkill shape.
        for mechanism in entry.get("mechanisms", []):
            assert "method" in mechanism, f"{cap}: mechanism missing method"
            assert "priority" in mechanism, f"{cap}: mechanism missing priority"
            assert "timeout_ms" in mechanism, f"{cap}: mechanism missing timeout_ms"
            assert "requires_internet" in mechanism, f"{cap}: mechanism missing requires_internet"
        # Parameter descriptors must declare type + required when present.
        for name, descriptor in (entry.get("parameters") or {}).items():
            assert isinstance(descriptor, dict), f"{cap}.{name}: descriptor must be dict"
            assert "type" in descriptor, f"{cap}.{name}: missing type"
            assert "required" in descriptor, f"{cap}.{name}: missing required"

    assert not missing_params, f"capabilities missing parameters: {missing_params}"
    assert not missing_mechanisms, f"capabilities missing mechanisms: {missing_mechanisms}"


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


def test_v2_router_routes_branded_named_thing_lookup_to_knowledge_query():
    runtime = get_runtime()
    chunk = RequestChunk(text="what is claude mythos", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "knowledge_query"
    assert match.confidence > 0.55


def test_v2_registry_gives_generic_alias_caps_multiple_examples():
    entries = {entry["capability"]: entry for entry in load_function_registry()}

    for capability in (
        "direct_chat",
        "chat",
        "query",
        "define_word",
        "calculate",
        "convert",
        "get_forecast",
        "translate",
        "assist",
        "send_text",
        "empathize",
        "lookup_birthday",
    ):
        examples = entries[capability].get("examples") or []
        assert len(examples) >= 3, f"{capability} should have at least 3 routing examples"


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
