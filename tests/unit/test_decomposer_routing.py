"""Unit tests for the routing-decomposer and its router integration.

Covers:
- capability_need → capability boost mapping
- RouteDecomposition authoritative detection
- Fallback paths (LLM disabled, timeout, unreachable, parse error)
- JSON extraction from noisy LLM output
- Router scoring with decomposer prior
- Prompt budget ceiling
"""
from __future__ import annotations

import asyncio
import os
import unittest
from unittest.mock import patch

from lokidoki.orchestrator.core.types import RequestChunk
from lokidoki.orchestrator.decomposer import (
    CAPABILITY_NEEDS,
    RouteDecomposition,
    capabilities_for_need,
    capability_boost,
    decompose_for_routing,
)
from lokidoki.orchestrator.decomposer.capability_map import (
    PRIMARY_BOOST,
    SECONDARY_BOOST,
)
from lokidoki.orchestrator.decomposer.client import (
    _normalize_capability_need,
    _parse_json,
)
from lokidoki.orchestrator.decomposer.prompt import (
    ROUTING_PROMPT,
    build_routing_prompt,
)
from lokidoki.orchestrator.routing.router import (
    _build_capability_boosts,
    route_chunk,
)


class TestPromptBudget(unittest.TestCase):
    """Routing prompt must stay compact — every token is per-turn latency."""

    def test_routing_prompt_under_ceiling(self):
        """ROUTING_PROMPT stays under 5500 chars."""
        self.assertLess(
            len(ROUTING_PROMPT), 5500,
            f"ROUTING_PROMPT is {len(ROUTING_PROMPT)} chars, over 5500 ceiling",
        )

    def test_build_routing_prompt_appends_input(self):
        built = build_routing_prompt("hello world")
        self.assertIn("INPUT: hello world", built)
        self.assertTrue(built.endswith("JSON:"))

    def test_build_routing_prompt_with_context(self):
        built = build_routing_prompt("is it free", recent_context="Claude Cowork")
        self.assertIn("CONTEXT: Claude Cowork", built)


class TestCapabilityMap(unittest.TestCase):
    """capability_need → target capability mapping."""

    def test_primary_boost_for_first_preference(self):
        # knowledge_query is the primary medical target — it's the
        # ZIM-backed handler, so offline-first flows succeed.
        self.assertEqual(
            capability_boost("medical", "knowledge_query"), PRIMARY_BOOST,
        )

    def test_secondary_boost_for_alt_preference(self):
        # look_up_symptom is a web-only secondary fallback.
        self.assertEqual(
            capability_boost("medical", "look_up_symptom"), SECONDARY_BOOST,
        )

    def test_zero_boost_for_unrelated_capability(self):
        self.assertEqual(capability_boost("medical", "get_weather"), 0.0)

    def test_none_gives_zero_boost(self):
        self.assertEqual(capability_boost("none", "knowledge_query"), 0.0)

    def test_unknown_need_gives_zero_boost(self):
        self.assertEqual(capability_boost("xyz", "knowledge_query"), 0.0)

    def test_all_enum_values_have_entries(self):
        """Every declared capability_need must have a mapping (even empty)."""
        for need in CAPABILITY_NEEDS:
            # Must not raise, must return a tuple
            self.assertIsInstance(capabilities_for_need(need), tuple)

    def test_archive_needs_map_to_knowledge_query(self):
        """Archive-scoped needs should all list knowledge_query as a target."""
        archive_needs = (
            "encyclopedic", "medical", "howto", "country_facts",
            "education", "technical_reference", "geographic",
        )
        for need in archive_needs:
            prefs = capabilities_for_need(need)
            self.assertIn(
                "knowledge_query", prefs,
                f"{need} preferences {prefs} must include knowledge_query",
            )


class TestRouteDecomposition(unittest.TestCase):
    """RouteDecomposition authoritative logic."""

    def test_llm_source_with_real_need_is_authoritative(self):
        rd = RouteDecomposition(capability_need="medical", source="llm")
        self.assertTrue(rd.is_authoritative())

    def test_llm_source_with_none_need_is_not_authoritative(self):
        rd = RouteDecomposition(capability_need="none", source="llm")
        self.assertFalse(rd.is_authoritative())

    def test_timeout_source_never_authoritative(self):
        rd = RouteDecomposition(capability_need="medical", source="timeout")
        self.assertFalse(rd.is_authoritative())

    def test_error_source_never_authoritative(self):
        rd = RouteDecomposition(capability_need="medical", source="error")
        self.assertFalse(rd.is_authoritative())

    def test_disabled_source_never_authoritative(self):
        rd = RouteDecomposition(capability_need="medical", source="disabled")
        self.assertFalse(rd.is_authoritative())


class TestCapabilityBoostsMap(unittest.TestCase):
    """_build_capability_boosts — converts decomposition to router input."""

    def test_none_decomposition_produces_empty_map(self):
        self.assertEqual(_build_capability_boosts(None), {})

    def test_non_authoritative_decomposition_produces_empty_map(self):
        rd = RouteDecomposition(capability_need="medical", source="timeout")
        self.assertEqual(_build_capability_boosts(rd), {})

    def test_authoritative_decomposition_builds_per_capability_map(self):
        rd = RouteDecomposition(capability_need="medical", source="llm")
        boosts = _build_capability_boosts(rd)
        # knowledge_query primary (ZIM-backed), look_up_symptom / check_medication secondary.
        self.assertEqual(boosts["knowledge_query"], PRIMARY_BOOST)
        self.assertEqual(boosts["look_up_symptom"], SECONDARY_BOOST)
        self.assertEqual(boosts["check_medication"], SECONDARY_BOOST)
        self.assertNotIn("get_weather", boosts)


class TestJSONParsing(unittest.TestCase):
    """_parse_json must tolerate model prose + markdown fences."""

    def test_clean_json(self):
        parsed = _parse_json('{"capability_need":"medical"}')
        self.assertEqual(parsed, {"capability_need": "medical"})

    def test_markdown_fenced_json(self):
        text = '```json\n{"capability_need":"howto"}\n```'
        parsed = _parse_json(text)
        self.assertEqual(parsed, {"capability_need": "howto"})

    def test_json_with_prose_prefix(self):
        text = 'Here is the answer: {"capability_need":"weather"}'
        parsed = _parse_json(text)
        self.assertEqual(parsed, {"capability_need": "weather"})

    def test_empty_string_returns_none(self):
        self.assertIsNone(_parse_json(""))

    def test_no_json_returns_none(self):
        self.assertIsNone(_parse_json("I don't know"))

    def test_broken_json_returns_none(self):
        self.assertIsNone(_parse_json('{"capability_need":'))


class TestCapabilityNeedNormalization(unittest.TestCase):
    """_normalize_capability_need coerces model output to valid enum."""

    def test_valid_lowercase_passes(self):
        self.assertEqual(_normalize_capability_need("medical"), "medical")

    def test_valid_uppercase_coerced(self):
        self.assertEqual(_normalize_capability_need("MEDICAL"), "medical")

    def test_whitespace_stripped(self):
        self.assertEqual(_normalize_capability_need("  howto  "), "howto")

    def test_unknown_coerced_to_none(self):
        self.assertEqual(_normalize_capability_need("foo"), "none")

    def test_non_string_coerced_to_none(self):
        self.assertEqual(_normalize_capability_need(None), "none")
        self.assertEqual(_normalize_capability_need(42), "none")
        self.assertEqual(_normalize_capability_need(["medical"]), "none")


class TestDecomposerCache(unittest.TestCase):
    """In-memory cache short-circuits repeat turns."""

    def setUp(self) -> None:
        from lokidoki.orchestrator.decomposer.cache import clear_cache
        clear_cache()

    def test_authoritative_result_is_cached(self):
        from lokidoki.orchestrator.decomposer.cache import (
            cache_size, get_cached, put_cached,
        )
        rd = RouteDecomposition(
            capability_need="medical", archive_hint="medlineplus",
            source="llm",
        )
        put_cached("my chest hurts", "", rd)
        self.assertEqual(cache_size(), 1)
        hit = get_cached("my chest hurts", "")
        self.assertIsNotNone(hit)
        self.assertEqual(hit.capability_need, "medical")

    def test_non_authoritative_result_not_cached(self):
        from lokidoki.orchestrator.decomposer.cache import (
            cache_size, get_cached, put_cached,
        )
        rd = RouteDecomposition(capability_need="medical", source="timeout")
        put_cached("my chest hurts", "", rd)
        self.assertEqual(cache_size(), 0)
        self.assertIsNone(get_cached("my chest hurts", ""))

    def test_case_and_whitespace_insensitive(self):
        from lokidoki.orchestrator.decomposer.cache import get_cached, put_cached
        rd = RouteDecomposition(capability_need="medical", source="llm")
        put_cached("My  Chest Hurts", "", rd)
        # Different casing / extra whitespace should still hit
        self.assertIsNotNone(get_cached("my chest   hurts", ""))
        self.assertIsNotNone(get_cached("MY CHEST HURTS", ""))

    def test_different_context_different_entry(self):
        from lokidoki.orchestrator.decomposer.cache import get_cached, put_cached
        rd_a = RouteDecomposition(capability_need="medical", source="llm")
        rd_b = RouteDecomposition(capability_need="howto", source="llm")
        put_cached("is it free", "Claude Cowork", rd_a)
        put_cached("is it free", "WikiHow", rd_b)
        self.assertEqual(get_cached("is it free", "Claude Cowork").capability_need, "medical")
        self.assertEqual(get_cached("is it free", "WikiHow").capability_need, "howto")


class TestDecomposeFallbacks(unittest.TestCase):
    """decompose_for_routing fallback paths."""

    def test_disabled_llm_returns_disabled_fallback(self):
        """When LOKI_LLM_ENABLED is off, returns a no-signal fallback."""
        # PYTEST_CURRENT_TEST is set, so CONFIG.llm_enabled is False by default.
        # Explicit override guards against future default changes.
        with patch.dict(os.environ, {"LOKI_LLM_ENABLED": "0"}):
            from lokidoki.orchestrator.core import config as config_module
            original_enabled = config_module.CONFIG.llm_enabled
            object.__setattr__(config_module.CONFIG, "llm_enabled", False)
            try:
                result = asyncio.run(decompose_for_routing("my chest hurts"))
            finally:
                object.__setattr__(config_module.CONFIG, "llm_enabled", original_enabled)
        self.assertEqual(result.source, "disabled")
        self.assertEqual(result.capability_need, "none")
        self.assertFalse(result.is_authoritative())

    def test_empty_input_returns_empty_fallback(self):
        result = asyncio.run(decompose_for_routing(""))
        self.assertEqual(result.capability_need, "none")
        self.assertFalse(result.is_authoritative())

    def test_whitespace_only_input_returns_empty_fallback(self):
        result = asyncio.run(decompose_for_routing("   \t  "))
        self.assertEqual(result.capability_need, "none")


class TestRouterDecomposerIntegration(unittest.TestCase):
    """End-to-end: route_chunk applies decomposer prior correctly."""

    def _make_runtime_with_index(self, router_index):
        """Build a minimal fake runtime with a fixed router_index + embedder."""
        from types import SimpleNamespace

        def embed_query(text: str) -> list[float]:
            return [1.0, 0.0, 0.0]

        return SimpleNamespace(
            router_index=router_index,
            embed_query=embed_query,
            capabilities={},
        )

    @staticmethod
    def _vec_for_cosine(target_cos: float) -> list[float]:
        """Build a unit vector whose cosine with [1,0,0] equals ``target_cos``.

        cos = x / |v|. Use x = target_cos and y = sqrt(1 - target_cos^2)
        so |v| = 1. Avoids the "all-same-direction" trap where any
        positive x gives cosine 1.0 regardless of magnitude.
        """
        import math
        y = math.sqrt(max(0.0, 1.0 - target_cos * target_cos))
        return [target_cos, y, 0.0]

    def test_no_decomposition_preserves_baseline_routing(self):
        """Without a decomposition, routing is cosine-only (no changes)."""
        runtime = self._make_runtime_with_index([
            {
                "capability": "knowledge_query",
                "texts": ["who is X"],
                "vectors": [self._vec_for_cosine(0.9)],
            },
            {
                "capability": "look_up_symptom",
                "texts": ["my head hurts"],
                "vectors": [self._vec_for_cosine(0.5)],
            },
        ])
        chunk = RequestChunk(text="chest pain", index=0)
        route = route_chunk(chunk, runtime=runtime, decomposition=None)
        self.assertEqual(route.capability, "knowledge_query")

    def test_decomposer_primary_boost_flips_against_non_preferred(self):
        """When the cosine winner is NOT in the decomposer's preference list,
        primary boost should flip to the preferred capability."""
        runtime = self._make_runtime_with_index([
            {
                "capability": "get_weather",  # not in medical preferences
                "texts": ["rain today"],
                "vectors": [self._vec_for_cosine(0.65)],
            },
            {
                "capability": "knowledge_query",  # medical PRIMARY target
                "texts": ["what causes X"],
                "vectors": [self._vec_for_cosine(0.55)],
            },
        ])
        rd = RouteDecomposition(capability_need="medical", source="llm")
        chunk = RequestChunk(text="chest pain", index=0)
        route = route_chunk(chunk, runtime=runtime, decomposition=rd)
        # get_weather: 0.65 + 0.0 = 0.65
        # knowledge_query: 0.55 + 0.15 = 0.70 ← wins
        self.assertEqual(route.capability, "knowledge_query")

    def test_confident_minilm_not_overridden_by_boost(self):
        """When MiniLM is VERY confident, decomposer boost can't flip it."""
        runtime = self._make_runtime_with_index([
            {
                "capability": "get_weather",  # not in medical preferences
                "texts": ["weather tomorrow"],
                "vectors": [self._vec_for_cosine(0.95)],
            },
            {
                "capability": "look_up_symptom",
                "texts": ["my head hurts"],
                "vectors": [self._vec_for_cosine(0.3)],
            },
        ])
        rd = RouteDecomposition(capability_need="medical", source="llm")
        chunk = RequestChunk(text="anything", index=0)
        route = route_chunk(chunk, runtime=runtime, decomposition=rd)
        # get_weather: 0.95 + 0.0 = 0.95
        # look_up_symptom: 0.3 + 0.15 = 0.45
        self.assertEqual(route.capability, "get_weather")

    def test_non_authoritative_decomp_noop(self):
        """A timed-out decomposition must NOT influence routing."""
        runtime = self._make_runtime_with_index([
            {
                "capability": "get_weather",
                "texts": ["rain today"],
                "vectors": [self._vec_for_cosine(0.65)],
            },
            {
                "capability": "look_up_symptom",
                "texts": ["my head hurts"],
                "vectors": [self._vec_for_cosine(0.55)],
            },
        ])
        rd = RouteDecomposition(capability_need="medical", source="timeout")
        chunk = RequestChunk(text="chest pain", index=0)
        route = route_chunk(chunk, runtime=runtime, decomposition=rd)
        # get_weather wins on cosine alone since timeout decomp is non-authoritative
        self.assertEqual(route.capability, "get_weather")


if __name__ == "__main__":
    unittest.main()
