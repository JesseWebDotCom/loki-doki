from __future__ import annotations

from lokidoki.orchestrator.registry.builder import build_router_index
from lokidoki.orchestrator.registry.loader import load_function_registry
from lokidoki.orchestrator.registry.runtime import get_runtime
from lokidoki.orchestrator.routing.router import route_chunk
from lokidoki.orchestrator.core.types import RequestChunk


def test_runtime_loads_capability_registry():
    runtime = get_runtime()

    assert runtime.capabilities
    assert "greeting_response" in runtime.capabilities
    assert "spell_word" in runtime.capabilities


def test_function_registry_has_parameters_and_mechanisms():
    """Every capability must declare a parameters dict and a mechanism
    chain so the executor / dev tools can introspect them."""
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
        # Mechanism descriptors must follow the BaseSkill shape.
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


def test_builder_precomputes_vectors_at_startup():
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


def test_router_uses_registry_backed_similarity():
    runtime = get_runtime()
    chunk = RequestChunk(text="what's the time", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "get_current_time"
    assert match.confidence > 0.6
    assert match.matched_text == "what's the time"


def test_router_handles_spelling_phrase_variant():
    runtime = get_runtime()
    chunk = RequestChunk(text="spell restaurant", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "spell_word"
    assert "spell" in match.matched_text


def test_router_routes_branded_named_thing_lookup_to_knowledge_query():
    # Use a phrasing that is NOT a literal example in the registry so
    # this exercises embedding generalization, not exact-match lookup.
    # "project glasswing" is present as "what is project glasswing";
    # "who came up with ..." is a paraphrase pattern that must still
    # land on knowledge_query via cosine similarity to nearby examples
    # ("who invented the lightbulb", "what is project glasswing").
    runtime = get_runtime()
    chunk = RequestChunk(text="who came up with project glasswing", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "knowledge_query"
    assert match.confidence > 0.55


def test_registry_gives_generic_alias_caps_multiple_examples():
    # NOTE: ``direct_chat`` is intentionally excluded. It is a pure
    # floor fallback — the router skips it in the cosine loop
    # (see lokidoki/orchestrator/routing/router.py), so its examples
    # are not used for routing. Requiring a coverage floor on them
    # would embed dead weight and make the data disagree with the
    # router.
    entries = {entry["capability"]: entry for entry in load_function_registry()}

    for capability in (
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


def test_router_prefers_prebuilt_vector_similarity_over_lexical_match():
    class StubRuntime:
        router_index = [
            {
                "capability": "set_timer",
                "texts": ["set a timer"],
                "vectors": [[-1.0, 0.0]],
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


def test_router_promotes_near_floor_knowledge_match_to_retrieval():
    class StubRuntime:
        router_index = [
            {
                "capability": "knowledge_query",
                "texts": ["what is project glasswing"],
                "vectors": [[1.0, 0.0]],
                "vector_dim": 2,
            },
            {
                "capability": "set_timer",
                "texts": ["set a timer"],
                "vectors": [[-1.0, 0.0]],
                "vector_dim": 2,
            },
        ]

        def embed_query(self, text: str) -> list[float]:
            assert text == "what is mythos preview"
            return [0.5, 0.8660254]

    chunk = RequestChunk(text="what is mythos preview", index=0)

    match = route_chunk(chunk, StubRuntime())

    assert match.capability == "knowledge_query"
    assert match.confidence > 0.55
    assert match.matched_text == "what is project glasswing"


def test_router_keeps_non_retrieval_near_floor_match_as_direct_chat():
    class StubRuntime:
        router_index = [
            {
                "capability": "set_timer",
                "texts": ["set a timer"],
                "vectors": [[1.0, 0.0]],
                "vector_dim": 2,
            },
        ]

        def embed_query(self, text: str) -> list[float]:
            assert text == "timer maybe"
            return [0.5, 0.8660254]

    chunk = RequestChunk(text="timer maybe", index=0)

    match = route_chunk(chunk, StubRuntime())

    assert match.capability == "direct_chat"
    assert match.confidence == 0.55


def test_router_matches_showtimes_prompt_with_zip_code():
    runtime = get_runtime()
    chunk = RequestChunk(text="show me movie times for hoppers in 90210", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "get_movie_showtimes"
    assert match.confidence > 0.55


def test_router_matches_fix_my_code_to_code_assistance():
    runtime = get_runtime()
    chunk = RequestChunk(text="fix my code", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "code_assistance"
    assert match.confidence > 0.55


def test_router_matches_frustrated_code_turn_to_emotional_support():
    runtime = get_runtime()
    chunk = RequestChunk(text="i'm frustrated my code isn't working", index=0)

    match = route_chunk(chunk, runtime)

    assert match.capability == "emotional_support"
    assert match.confidence > 0.55


class TestWHQuestionPromotion:
    """WH-question promotion sends factual questions to knowledge_query."""

    def test_what_year_promotes(self):
        from lokidoki.orchestrator.routing.router import _is_factual_wh_question
        assert _is_factual_wh_question("what year was corey feldman on the masked singer")

    def test_what_time_promotes(self):
        from lokidoki.orchestrator.routing.router import _is_factual_wh_question
        assert _is_factual_wh_question("what time does the store close")

    def test_what_day_promotes(self):
        from lokidoki.orchestrator.routing.router import _is_factual_wh_question
        assert _is_factual_wh_question("what day is thanksgiving")

    def test_what_was_promotes(self):
        from lokidoki.orchestrator.routing.router import _is_factual_wh_question
        assert _is_factual_wh_question("what was the first star wars movie")

    def test_how_many_promotes(self):
        from lokidoki.orchestrator.routing.router import _is_factual_wh_question
        assert _is_factual_wh_question("how many seasons of the office are there")

    def test_where_was_promotes(self):
        from lokidoki.orchestrator.routing.router import _is_factual_wh_question
        assert _is_factual_wh_question("where was marie curie born")

    def test_where_did_promotes(self):
        from lokidoki.orchestrator.routing.router import _is_factual_wh_question
        assert _is_factual_wh_question("where did the titanic sink")

    def test_chitchat_excluded(self):
        from lokidoki.orchestrator.routing.router import _is_factual_wh_question
        assert not _is_factual_wh_question("what's up")
        assert not _is_factual_wh_question("how are you")
