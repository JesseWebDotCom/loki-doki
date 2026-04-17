"""Decomposer prompt budget and resolved_query field tests."""
from __future__ import annotations

from lokidoki.core.prompts.decomposition import DECOMPOSITION_PROMPT
from lokidoki.orchestrator.core.types import RouteMatch


class TestDecomposerPromptBudget:
    """DECOMPOSITION_PROMPT must stay under 8,000 chars."""

    def test_prompt_under_8000_chars(self):
        length = len(DECOMPOSITION_PROMPT)
        assert length < 8000, (
            f"DECOMPOSITION_PROMPT is {length} chars, exceeds 8,000 budget"
        )

    def test_prompt_contains_resolved_query_field(self):
        assert "resolved_query" in DECOMPOSITION_PROMPT


class TestResolvedQueryField:
    """RouteMatch carries resolved_query for downstream consumers."""

    def test_route_match_has_resolved_query_default(self):
        route = RouteMatch(chunk_index=0, capability="direct_chat", confidence=0.8)
        assert route.resolved_query == ""

    def test_route_match_resolved_query_set_explicitly(self):
        route = RouteMatch(
            chunk_index=0,
            capability="knowledge_query",
            confidence=0.9,
            resolved_query="is Claude Cowork free",
        )
        assert route.resolved_query == "is Claude Cowork free"

    def test_route_match_resolved_query_fallback_to_raw_text(self):
        """When resolved_query is absent, downstream should fall back to chunk text."""
        route = RouteMatch(chunk_index=0, capability="direct_chat", confidence=0.7)
        raw_text = "is it free"
        effective = route.resolved_query or raw_text
        assert effective == raw_text

    def test_route_match_resolved_query_preferred_over_raw(self):
        """When resolved_query is present, it takes precedence over raw text."""
        route = RouteMatch(
            chunk_index=0,
            capability="knowledge_query",
            confidence=0.9,
            resolved_query="is Claude Cowork free",
        )
        raw_text = "is it free"
        effective = route.resolved_query or raw_text
        assert effective == "is Claude Cowork free"
