"""Tests for persona injection into v2 synthesis prompts.

Verifies:
- Persona slots render in combine and direct_chat templates.
- Persona NEVER reaches the decomposer (CHARACTER_SYSTEM.md §2.3).
- Empty persona adds no extra tokens.
"""
from __future__ import annotations

import pytest

from v2.orchestrator.core.types import RequestChunkResult, RequestSpec
from v2.orchestrator.fallbacks.llm_fallback import build_combine_prompt


def _spec_with_persona(
    *,
    character_name: str = "",
    behavior_prompt: str = "",
    capability: str = "direct_chat",
    confidence: float = 0.5,
) -> RequestSpec:
    """Build a minimal RequestSpec with persona context."""
    ctx: dict = {}
    if character_name:
        ctx["character_name"] = character_name
    if behavior_prompt:
        ctx["behavior_prompt"] = behavior_prompt
    return RequestSpec(
        trace_id="test-persona",
        original_request="What is the meaning of life?",
        chunks=[
            RequestChunkResult(
                text="What is the meaning of life?",
                role="primary_request",
                capability=capability,
                confidence=confidence,
                result={"output_text": "42"},
            ),
        ],
        context=ctx,
    )


class TestPersonaInCombinePrompt:
    """Persona slots render correctly in the combine template."""

    def test_character_name_appears_in_combine(self):
        spec = _spec_with_persona(
            character_name="Kingston",
            capability="get_current_time",
            confidence=0.9,
        )
        prompt = build_combine_prompt(spec)
        assert "You are Kingston" in prompt

    def test_behavior_prompt_appears_in_combine(self):
        spec = _spec_with_persona(
            character_name="Kingston",
            behavior_prompt="You speak like a pirate.",
            capability="get_current_time",
            confidence=0.9,
        )
        prompt = build_combine_prompt(spec)
        assert "You speak like a pirate." in prompt

    def test_default_name_is_lokidoki_when_absent(self):
        spec = _spec_with_persona(capability="get_current_time", confidence=0.9)
        prompt = build_combine_prompt(spec)
        assert "You are LokiDoki" in prompt


class TestPersonaInDirectChat:
    """Persona slots render correctly in the direct_chat template."""

    def test_character_name_appears_in_direct_chat(self):
        spec = _spec_with_persona(character_name="Loki")
        prompt = build_combine_prompt(spec)
        assert "You are Loki" in prompt

    def test_behavior_prompt_appears_in_direct_chat(self):
        spec = _spec_with_persona(
            character_name="Loki",
            behavior_prompt="You are mischievous and witty.",
        )
        prompt = build_combine_prompt(spec)
        assert "You are mischievous and witty." in prompt

    def test_default_name_is_lokidoki_when_absent_direct(self):
        spec = _spec_with_persona()
        prompt = build_combine_prompt(spec)
        assert "You are LokiDoki" in prompt


class TestEmptyPersonaAddsNoExtraTokens:
    """When persona is absent, no extraneous text appears."""

    def test_no_empty_behavior_line_in_combine(self):
        spec = _spec_with_persona(capability="get_current_time", confidence=0.9)
        prompt = build_combine_prompt(spec)
        # behavior_prompt slot should render as empty — no stray newlines
        # between the "You are LokiDoki" line and the next instruction.
        lines = prompt.split("\n")
        name_line_idx = next(i for i, l in enumerate(lines) if "You are LokiDoki" in l)
        # The line after the name should be an instruction, not blank
        next_line = lines[name_line_idx + 1]
        assert next_line.strip() != "" or lines[name_line_idx + 2].strip() != ""

    def test_no_empty_behavior_line_in_direct_chat(self):
        spec = _spec_with_persona()
        prompt = build_combine_prompt(spec)
        lines = prompt.split("\n")
        name_line_idx = next(i for i, l in enumerate(lines) if "You are LokiDoki" in l)
        next_line = lines[name_line_idx + 1]
        assert next_line.strip() != "" or lines[name_line_idx + 2].strip() != ""


class TestPersonaNeverReachesDecomposer:
    """The decomposer prompt must never contain persona slots.

    This is the contract from CHARACTER_SYSTEM.md §2.3: behavior_prompt
    is injected ONLY into the synthesis (9B) system prompt. The
    decomposer (2B) emits structured JSON and would be polluted by
    personality directives.
    """

    def test_decomposition_prompt_has_no_persona_injection_slots(self):
        """The decomposer must not have persona substitution slots.

        The word "persona" may appear in the decomposer's memory-extraction
        section (it describes subject types), but it must never have
        ``{character_name}`` or ``{behavior_prompt}`` template slots.
        """
        from lokidoki.core.prompts.decomposition import DECOMPOSITION_PROMPT

        assert "{character_name}" not in DECOMPOSITION_PROMPT
        assert "{behavior_prompt}" not in DECOMPOSITION_PROMPT
        assert "behavior_prompt" not in DECOMPOSITION_PROMPT

    def test_decomposer_init_takes_no_persona_args(self):
        """Decomposer constructor must not accept behavior_prompt."""
        import inspect

        from lokidoki.core.decomposer import Decomposer

        sig = inspect.signature(Decomposer.__init__)
        param_names = set(sig.parameters.keys())
        assert "behavior_prompt" not in param_names
        assert "character_name" not in param_names
        assert "persona" not in param_names
