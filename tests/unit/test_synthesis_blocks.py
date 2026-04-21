"""Tests for the chunk-14 synthesis-blocks populator.

Covers:

* ``aggregate_key_facts`` — deterministic flatten/dedupe.
* ``extract_steps`` — constrained-JSON island vs adapter fallback
  (recipes), no fabrication.
* ``extract_comparison`` — constrained-JSON island vs
  subjects-only scaffold.
* ``populate_text_blocks`` — drives block state transitions
  (ready / omitted) in-place.
* Planner enrichment budget — the ``_TEXT_BLOCK_BUDGET`` contract is
  observed by ``plan_initial_blocks`` across all modes.
"""
from __future__ import annotations

from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType
from lokidoki.orchestrator.response.mode import PlannerInputs
from lokidoki.orchestrator.response.planner import (
    enforce_text_block_budget,
    plan_initial_blocks,
    text_block_budget,
)
from lokidoki.orchestrator.response.synthesis_blocks import (
    aggregate_key_facts,
    extract_comparison,
    extract_steps,
    populate_text_blocks,
)


# ---------------------------------------------------------------------------
# aggregate_key_facts
# ---------------------------------------------------------------------------


class TestAggregateKeyFacts:
    """Deterministic flatten from AdapterOutput.facts."""

    def test_flattens_facts_across_outputs(self) -> None:
        outputs = [
            AdapterOutput(facts=("Luke is a Jedi.", "Luke trained with Yoda.")),
            AdapterOutput(facts=("Leia is a senator.",)),
        ]

        items = aggregate_key_facts(outputs)

        assert items == [
            {"text": "Luke is a Jedi."},
            {"text": "Luke trained with Yoda."},
            {"text": "Leia is a senator."},
        ]

    def test_dedupes_identical_facts(self) -> None:
        outputs = [
            AdapterOutput(facts=("Same fact.",)),
            AdapterOutput(facts=("Same fact.",)),
        ]

        items = aggregate_key_facts(outputs)

        assert items == [{"text": "Same fact."}]

    def test_ignores_none_and_empty_entries(self) -> None:
        outputs = [None, AdapterOutput(), AdapterOutput(facts=("", "   "))]

        items = aggregate_key_facts(outputs)

        assert items == []

    def test_respects_default_limit(self) -> None:
        outputs = [AdapterOutput(facts=tuple(f"Fact {i}" for i in range(20)))]

        items = aggregate_key_facts(outputs)

        assert len(items) == 8


# ---------------------------------------------------------------------------
# extract_steps
# ---------------------------------------------------------------------------


class TestExtractSteps:
    """Constrained-JSON preferred; adapter fallback next; no fabrication."""

    def test_constrained_json_island_wins(self) -> None:
        synthesis_text = (
            "Here is what to do.\n"
            "<blocks:steps>"
            '{"items": ["Turn off the water.", "Remove the handle.",'
            ' {"text": "Replace the washer.", "substeps": ["Unscrew", "Swap"]}]}'
            "</blocks:steps>\n"
            "Good luck!"
        )

        result = extract_steps(
            synthesis_text=synthesis_text,
            adapter_outputs=[],
            profile="mac",
        )

        assert result.source == "constrained"
        assert result.items == [
            {"n": 1, "text": "Turn off the water."},
            {"n": 2, "text": "Remove the handle."},
            {
                "n": 3,
                "text": "Replace the washer.",
                "substeps": ["Unscrew", "Swap"],
            },
        ]

    def test_adapter_recipes_fallback(self) -> None:
        raw = {
            "recipes": [
                {
                    "name": "Padme's Naboo Stew",
                    "instructions": (
                        "Chop vegetables. Brown the meat. Simmer for an hour. "
                        "Serve hot."
                    ),
                }
            ]
        }
        output = AdapterOutput(raw=raw)

        result = extract_steps(
            synthesis_text="(summary without a steps island)",
            adapter_outputs=[output],
            profile="pi_cpu",
        )

        assert result.source == "adapter"
        assert result.items is not None
        texts = [entry["text"] for entry in result.items]
        assert texts == [
            "Chop vegetables.",
            "Brown the meat.",
            "Simmer for an hour.",
            "Serve hot.",
        ]

    def test_no_constrained_no_adapter_returns_none(self) -> None:
        """Never fabricates — neither source available → omit the block."""
        result = extract_steps(
            synthesis_text="Plain prose with no island.",
            adapter_outputs=[AdapterOutput(facts=("Some fact.",))],
            profile="mac",
        )

        assert result.items is None
        assert result.source == "none"

    def test_malformed_json_island_degrades_to_none(self) -> None:
        synthesis_text = "<blocks:steps>{not valid json}</blocks:steps>"

        result = extract_steps(
            synthesis_text=synthesis_text,
            adapter_outputs=[],
            profile="mac",
        )

        assert result.items is None
        assert result.source == "none"


# ---------------------------------------------------------------------------
# extract_comparison
# ---------------------------------------------------------------------------


class TestExtractComparison:
    """Constrained-JSON preferred; subject scaffold next; no fabrication."""

    def test_constrained_json_full_shape(self) -> None:
        synthesis_text = (
            "Wikipedia and Wikimedia differ in mission.\n"
            "<blocks:comparison>"
            '{"left": {"title": "Wikipedia",'
            ' "items": ["encyclopedia", "multilingual"]},'
            ' "right": {"title": "Wikimedia Foundation",'
            ' "items": ["umbrella org", "hosts projects"]},'
            ' "dimensions": ["purpose", "scope"]}'
            "</blocks:comparison>"
        )

        result = extract_comparison(
            synthesis_text=synthesis_text,
            subjects=("Ignored", "Alsoignored"),
            profile="mac",
        )

        assert result.source == "constrained"
        assert result.comparison == {
            "left": {
                "title": "Wikipedia",
                "items": ["encyclopedia", "multilingual"],
            },
            "right": {
                "title": "Wikimedia Foundation",
                "items": ["umbrella org", "hosts projects"],
            },
            "dimensions": ["purpose", "scope"],
        }

    def test_subjects_scaffold_when_no_island(self) -> None:
        result = extract_comparison(
            synthesis_text="Plain prose, no island emitted.",
            subjects=("Luke Skywalker", "Leia Organa"),
            profile="pi_cpu",
        )

        assert result.source == "adapter"
        assert result.comparison == {
            "left": {"title": "Luke Skywalker", "items": []},
            "right": {"title": "Leia Organa", "items": []},
            "dimensions": [],
        }

    def test_no_subjects_no_island_returns_none(self) -> None:
        result = extract_comparison(
            synthesis_text="",
            subjects=None,
            profile="mac",
        )

        assert result.comparison is None
        assert result.source == "none"


# ---------------------------------------------------------------------------
# populate_text_blocks
# ---------------------------------------------------------------------------


def _block(block_type: BlockType) -> Block:
    return Block(
        id=block_type.value,
        type=block_type,
        state=BlockState.loading,
        seq=0,
    )


class TestPopulateTextBlocks:
    """Drives the pipeline-facing populator: in-place state transitions."""

    def test_key_facts_ready_when_facts_exist(self) -> None:
        blocks = [_block(BlockType.key_facts)]
        outputs = [AdapterOutput(facts=("Luke is a Jedi.",))]

        populate_text_blocks(
            blocks,
            synthesis_text="",
            adapter_outputs=outputs,
        )

        assert blocks[0].state is BlockState.ready
        assert blocks[0].items == [{"text": "Luke is a Jedi."}]

    def test_key_facts_omitted_when_no_facts(self) -> None:
        blocks = [_block(BlockType.key_facts)]

        populate_text_blocks(
            blocks,
            synthesis_text="",
            adapter_outputs=[AdapterOutput()],
        )

        assert blocks[0].state is BlockState.omitted
        assert blocks[0].items == []

    def test_steps_omitted_when_no_constrained_and_no_adapter(self) -> None:
        blocks = [_block(BlockType.steps)]

        populate_text_blocks(
            blocks,
            synthesis_text="No island here.",
            adapter_outputs=[AdapterOutput()],
        )

        assert blocks[0].state is BlockState.omitted
        assert blocks[0].items == []

    def test_comparison_uses_subject_scaffold_when_no_island(self) -> None:
        blocks = [_block(BlockType.comparison)]

        populate_text_blocks(
            blocks,
            synthesis_text="",
            adapter_outputs=[],
            comparison_subjects=("Anakin", "Padme"),
        )

        assert blocks[0].state is BlockState.ready
        assert blocks[0].comparison == {
            "left": {"title": "Anakin", "items": []},
            "right": {"title": "Padme", "items": []},
            "dimensions": [],
        }

    def test_ignores_non_text_blocks(self) -> None:
        sources_block = Block(
            id="sources",
            type=BlockType.sources,
            state=BlockState.ready,
            seq=0,
            items=[{"title": "stub"}],
        )

        populate_text_blocks(
            [sources_block],
            synthesis_text="",
            adapter_outputs=[],
        )

        # Sources block left untouched.
        assert sources_block.state is BlockState.ready
        assert sources_block.items == [{"title": "stub"}]


# ---------------------------------------------------------------------------
# Planner enrichment-budget table
# ---------------------------------------------------------------------------


class TestEnrichmentBudget:
    """Per-mode budget table rejects overruns; planner respects it."""

    def test_direct_mode_has_no_text_blocks(self) -> None:
        budget = text_block_budget("direct")
        assert budget == {
            BlockType.key_facts: 0,
            BlockType.steps: 0,
            BlockType.comparison: 0,
        }

    def test_search_and_artifact_also_empty(self) -> None:
        for mode in ("search", "artifact"):
            assert text_block_budget(mode) == {
                BlockType.key_facts: 0,
                BlockType.steps: 0,
                BlockType.comparison: 0,
            }

    def test_rich_mode_allows_all_three(self) -> None:
        budget = text_block_budget("rich")
        assert budget[BlockType.key_facts] == 1
        assert budget[BlockType.steps] == 1
        assert budget[BlockType.comparison] == 1

    def test_unknown_mode_falls_back_to_standard(self) -> None:
        assert text_block_budget("gibberish") == text_block_budget("standard")

    def test_enforce_budget_rejects_extra_blocks_in_direct(self) -> None:
        blocks = [
            Block(id="summary", type=BlockType.summary, state=BlockState.ready),
            Block(
                id="key_facts",
                type=BlockType.key_facts,
                state=BlockState.ready,
                items=[{"text": "not allowed in direct"}],
            ),
        ]

        assert enforce_text_block_budget(blocks, "direct") is False

    def test_enforce_budget_rejects_two_text_blocks_in_standard(self) -> None:
        blocks = [
            Block(id="summary", type=BlockType.summary, state=BlockState.ready),
            Block(id="steps", type=BlockType.steps, state=BlockState.ready),
            Block(
                id="comparison",
                type=BlockType.comparison,
                state=BlockState.ready,
            ),
        ]

        # standard mode caps TOTAL text blocks at 1.
        assert enforce_text_block_budget(blocks, "standard") is False

    def test_enforce_budget_accepts_rich_triple(self) -> None:
        blocks = [
            Block(id="summary", type=BlockType.summary, state=BlockState.ready),
            Block(id="key_facts", type=BlockType.key_facts, state=BlockState.ready),
            Block(id="steps", type=BlockType.steps, state=BlockState.ready),
            Block(
                id="comparison",
                type=BlockType.comparison,
                state=BlockState.ready,
            ),
        ]

        assert enforce_text_block_budget(blocks, "rich") is True


# ---------------------------------------------------------------------------
# Planner mode-specific pre-allocation
# ---------------------------------------------------------------------------


class TestPlannerAllocation:
    """Chunk 14 pre-allocates ``key_facts`` / ``steps`` / ``comparison``."""

    def test_rich_mode_always_allocates_key_facts(self) -> None:
        outputs = [
            AdapterOutput(
                sources=(Source(title="Luke", url="file:///offline/luke.html"),),
                facts=("Luke is a Jedi.",),
            ),
        ]
        inputs = PlannerInputs(
            response_shape="synthesized",
            capability_need="encyclopedic",
        )

        blocks = plan_initial_blocks(outputs, mode="rich", planner_inputs=inputs)
        ids = [b.id for b in blocks]

        assert "key_facts" in ids
        # No how-to or comparison signal → neither of those is allocated.
        assert "steps" not in ids
        assert "comparison" not in ids

    def test_rich_mode_allocates_steps_for_howto_capability(self) -> None:
        outputs = [
            AdapterOutput(
                sources=(Source(title="Recipe", url="file:///offline/r.html"),),
            ),
        ]
        inputs = PlannerInputs(
            response_shape="synthesized",
            capability_need="howto",
        )

        blocks = plan_initial_blocks(outputs, mode="rich", planner_inputs=inputs)
        ids = [b.id for b in blocks]

        assert "steps" in ids

    def test_rich_mode_allocates_steps_for_troubleshooting_shape(self) -> None:
        inputs = PlannerInputs(
            response_shape="troubleshooting",
            capability_need="none",
        )

        blocks = plan_initial_blocks([], mode="rich", planner_inputs=inputs)
        ids = [b.id for b in blocks]

        assert "steps" in ids

    def test_rich_mode_allocates_comparison_for_comparison_shape(self) -> None:
        inputs = PlannerInputs(
            response_shape="comparison",
            capability_need="encyclopedic",
        )

        blocks = plan_initial_blocks([], mode="rich", planner_inputs=inputs)
        ids = [b.id for b in blocks]

        assert "comparison" in ids

    def test_standard_mode_allocates_at_most_one_text_block(self) -> None:
        # Both signals fire; standard mode picks comparison (priority winner).
        inputs = PlannerInputs(
            response_shape="comparison",
            capability_need="howto",
        )

        blocks = plan_initial_blocks([], mode="standard", planner_inputs=inputs)
        ids = [b.id for b in blocks]

        assert ids.count("comparison") == 1
        assert "steps" not in ids
        # key_facts is NOT pre-allocated in standard mode (per chunk-14 design).
        assert "key_facts" not in ids
        assert enforce_text_block_budget(blocks, "standard") is True

    def test_standard_mode_falls_through_to_steps_when_only_howto(self) -> None:
        inputs = PlannerInputs(
            response_shape="",
            capability_need="howto",
        )

        blocks = plan_initial_blocks([], mode="standard", planner_inputs=inputs)
        ids = [b.id for b in blocks]

        assert "steps" in ids
        assert "comparison" not in ids

    def test_standard_mode_no_signals_no_text_blocks(self) -> None:
        inputs = PlannerInputs(capability_need="encyclopedic")

        blocks = plan_initial_blocks([], mode="standard", planner_inputs=inputs)
        ids = [b.id for b in blocks]

        assert "steps" not in ids
        assert "comparison" not in ids
        assert "key_facts" not in ids

    def test_direct_mode_never_allocates_text_blocks(self) -> None:
        inputs = PlannerInputs(
            response_shape="comparison",
            capability_need="howto",
        )

        blocks = plan_initial_blocks([], mode="direct", planner_inputs=inputs)
        ids = [b.id for b in blocks]

        assert "key_facts" not in ids
        assert "steps" not in ids
        assert "comparison" not in ids
        assert enforce_text_block_budget(blocks, "direct") is True
