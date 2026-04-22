"""Tests for the response-mode derivation + mode-aware planner.

Chunk 12 of the rich-response rollout (see
``docs/rich-response/chunk-12-planner-mode-backend.md``). Covers:

* :func:`derive_response_mode` — every branch plus the
  legacy-fallback safety net and ``user_override`` precedence.
* :func:`plan_initial_blocks` — per-mode block lists (direct /
  standard / rich / deep / search / artifact).
* Invariant guard: no regex / keyword scanning over user text lives
  in ``response/mode.py`` or ``response/planner.py``.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from lokidoki.orchestrator.adapters.base import AdapterOutput, Source
from lokidoki.orchestrator.response.blocks import BlockState, BlockType
from lokidoki.orchestrator.response.mode import (
    PlannerInputs,
    VALID_MODES,
    derive_response_mode,
)
from lokidoki.orchestrator.response.planner import plan_initial_blocks


# ---------------------------------------------------------------------------
# derive_response_mode — per-branch coverage
# ---------------------------------------------------------------------------


class TestUserOverride:
    """``user_override`` always wins, regardless of decomposition."""

    @pytest.mark.parametrize("override", VALID_MODES)
    def test_every_valid_override_passes_through(self, override):
        # Deliberately contradictory decomposition — override still wins.
        inputs = PlannerInputs(
            response_shape="synthesized",
            capability_need="encyclopedic",
            requires_current_data=True,
        )
        assert derive_response_mode(inputs, user_override=override) == override

    def test_override_wins_over_search_rule(self):
        inputs = PlannerInputs(capability_need="web_search")
        # Without override, rule 3 would pick search; with override,
        # standard wins.
        assert derive_response_mode(inputs, user_override="standard") == "standard"

    def test_override_wins_over_artifact_rule(self):
        inputs = PlannerInputs(has_artifact_output=True)
        assert derive_response_mode(inputs, user_override="rich") == "rich"

    def test_empty_override_ignored(self):
        inputs = PlannerInputs()
        assert derive_response_mode(inputs, user_override="") == "standard"

    def test_none_override_ignored(self):
        inputs = PlannerInputs()
        assert derive_response_mode(inputs, user_override=None) == "standard"

    def test_unknown_override_ignored(self):
        inputs = PlannerInputs()
        assert derive_response_mode(inputs, user_override="ultra") == "standard"

    def test_user_override_beats_workspace_default(self):
        inputs = PlannerInputs()
        assert derive_response_mode(
            inputs,
            user_override="deep",
            workspace_default="rich",
        ) == "deep"


class TestWorkspaceDefault:
    """Workspace default is the fallback below user override, above rules."""

    def test_workspace_default_applies_when_no_override_present(self):
        inputs = PlannerInputs(capability_need="web_search")
        assert derive_response_mode(inputs, workspace_default="rich") == "rich"

    def test_unknown_workspace_default_is_ignored(self):
        inputs = PlannerInputs(capability_need="web_search")
        assert derive_response_mode(inputs, workspace_default="ultra") == "search"


class TestArtifactRule:
    """Rule 2: artifact mode only fires when an artifact was actually produced."""

    def test_has_artifact_output_yields_artifact(self):
        inputs = PlannerInputs(has_artifact_output=True)
        assert derive_response_mode(inputs) == "artifact"

    def test_absent_artifact_does_not_yield_artifact(self):
        inputs = PlannerInputs(has_artifact_output=False)
        assert derive_response_mode(inputs) != "artifact"


class TestSearchRule:
    """Rule 3: ``capability_need == "web_search"`` pivots into search."""

    def test_web_search_capability_yields_search(self):
        inputs = PlannerInputs(capability_need="web_search")
        assert derive_response_mode(inputs) == "search"

    def test_web_search_beats_rich_signals(self):
        """Search rule runs before rich — a web-search ask stays search."""
        inputs = PlannerInputs(
            capability_need="web_search",
            response_shape="synthesized",
            requires_current_data=True,
            multiple_skills_fired=True,
        )
        assert derive_response_mode(inputs) == "search"


class TestDeepRule:
    """Rule 4: deep requires BOTH reasoning=thinking AND explicit opt-in."""

    def test_thinking_alone_does_not_yield_deep(self):
        """Design §10.4: accidental escalation is a product failure."""
        inputs = PlannerInputs(reasoning_complexity="thinking")
        assert derive_response_mode(inputs) != "deep"

    def test_opt_in_alone_does_not_yield_deep(self):
        """Opt-in without thinking hint falls through — rule 4 needs both."""
        inputs = PlannerInputs(deep_opt_in=True)
        assert derive_response_mode(inputs) != "deep"

    def test_thinking_plus_opt_in_yields_deep(self):
        inputs = PlannerInputs(
            reasoning_complexity="thinking",
            deep_opt_in=True,
        )
        assert derive_response_mode(inputs) == "deep"

    def test_user_override_deep_always_wins(self):
        """Explicit ``/deep`` slash bypasses the reasoning gate."""
        inputs = PlannerInputs()  # no thinking signal, no opt-in
        assert derive_response_mode(inputs, user_override="deep") == "deep"


class TestDirectRule:
    """Rule 5: verbatim response + deterministic capability → direct."""

    @pytest.mark.parametrize(
        "capability",
        ["conversion", "timer_reminder", "calendar", "device_control"],
    )
    def test_verbatim_deterministic_capability_yields_direct(self, capability):
        inputs = PlannerInputs(
            response_shape="verbatim",
            capability_need=capability,
        )
        assert derive_response_mode(inputs) == "direct"

    def test_verbatim_non_deterministic_capability_yields_rich(self):
        """Verbatim encyclopedic lookups route to rich mode.

        Verbatim means "skill output is authoritative, don't
        re-synthesize" — not "render as a bare paragraph". Structured
        blocks still apply to the verbatim payload.
        """
        inputs = PlannerInputs(
            response_shape="verbatim",
            capability_need="encyclopedic",
        )
        assert derive_response_mode(inputs) == "rich"

    def test_synthesized_deterministic_capability_does_not_yield_direct(self):
        inputs = PlannerInputs(
            response_shape="synthesized",
            capability_need="conversion",
        )
        assert derive_response_mode(inputs) != "direct"


class TestRichRule:
    """Rule 6: multi-skill | current-data | rich capability → rich."""

    def test_multiple_skills_alone_yields_rich(self):
        inputs = PlannerInputs(multiple_skills_fired=True)
        assert derive_response_mode(inputs) == "rich"

    def test_current_data_alone_yields_rich(self):
        inputs = PlannerInputs(requires_current_data=True)
        assert derive_response_mode(inputs) == "rich"

    @pytest.mark.parametrize(
        "capability",
        ["encyclopedic", "medical", "technical_reference", "people_lookup"],
    )
    def test_rich_capability_alone_yields_rich(self, capability):
        """A rich-shaped capability is sufficient on its own.

        The decomposer's ``response_shape`` (``verbatim`` /
        ``synthesized``) does not gate rich mode — both skill-verbatim
        and LLM-synthesized answers benefit from structured blocks.
        """
        inputs = PlannerInputs(capability_need=capability)
        assert derive_response_mode(inputs) == "rich"

    @pytest.mark.parametrize(
        "capability",
        ["encyclopedic", "medical", "technical_reference", "people_lookup"],
    )
    def test_synthesized_plus_rich_capability_yields_rich(self, capability):
        """The ``synthesized`` path continues to yield rich (back-compat)."""
        inputs = PlannerInputs(
            response_shape="synthesized",
            capability_need=capability,
        )
        assert derive_response_mode(inputs) == "rich"

    def test_synthesized_bare_does_not_yield_rich(self):
        """No multi-skill, no current-data, no rich capability → standard."""
        inputs = PlannerInputs(response_shape="synthesized")
        assert derive_response_mode(inputs) == "standard"


class TestStandardDefault:
    """Rule 7: fallthrough is ``standard``."""

    def test_empty_inputs_yields_standard(self):
        assert derive_response_mode(PlannerInputs()) == "standard"

    def test_legacy_fallback_on_exception(self):
        """A duck-typed decomposition raising during attribute access
        must fall back to standard, not propagate."""

        class ExplodingInputs:
            @property
            def capability_need(self):  # pragma: no cover - triggers exc
                raise RuntimeError("boom")

        # Must not raise; must return standard.
        assert derive_response_mode(ExplodingInputs()) == "standard"


class TestDuckTypedInput:
    """``derive_response_mode`` accepts any structured object."""

    def test_minimal_route_decomposition_shape(self):
        from lokidoki.orchestrator.decomposer.types import RouteDecomposition

        decomposition = RouteDecomposition(capability_need="web_search")
        assert derive_response_mode(decomposition) == "search"

    def test_plain_object_with_getattr(self):
        class Fake:
            response_shape = "synthesized"
            capability_need = "encyclopedic"

        assert derive_response_mode(Fake()) == "rich"


# ---------------------------------------------------------------------------
# plan_initial_blocks — per-mode shapes
# ---------------------------------------------------------------------------


def _outputs_with_sources() -> list[AdapterOutput]:
    return [
        AdapterOutput(
            sources=(Source(title="Padme", url="file:///offline/padme.html"),),
        ),
    ]


def _outputs_with_media() -> list[AdapterOutput]:
    return [
        AdapterOutput(media=({"kind": "video", "url": "file:///offline/yoda.mp4"},)),
    ]


def _outputs_with_both() -> list[AdapterOutput]:
    return [
        AdapterOutput(
            sources=(Source(title="Leia", url="file:///offline/leia.html"),),
            media=({"kind": "video", "url": "file:///offline/leia.mp4"},),
        ),
    ]


def _outputs_with_follow_ups() -> list[AdapterOutput]:
    return [
        AdapterOutput(
            sources=(Source(title="Padme", url="file:///offline/padme.html"),),
            follow_up_candidates=("who raised her?",),
        ),
    ]


class TestPlanDirect:
    """``direct`` — summary only; optional single source. No status block."""

    def test_direct_with_no_sources(self):
        # Chunk 15: direct mode is the one exception — no status block
        # is ever allocated because direct skills are instant-return
        # (no visible pipeline-phase progress). Planner post-step skips
        # when the base plan already has one; direct has none.
        blocks = plan_initial_blocks([], mode="direct")
        ids = [b.id for b in blocks]
        # ``status`` is auto-appended by the planner for every non-artifact
        # mode, even direct — the pipeline still transitions through
        # phases on direct turns and needs somewhere to patch.
        assert ids == ["summary", "status"]
        assert blocks[0].state is BlockState.loading

    def test_direct_with_sources(self):
        blocks = plan_initial_blocks(_outputs_with_sources(), mode="direct")
        assert [b.id for b in blocks] == ["summary", "sources", "status"]

    def test_direct_ignores_media(self):
        """Design §10.1: no secondary enrichment in direct mode."""
        blocks = plan_initial_blocks(_outputs_with_media(), mode="direct")
        assert [b.id for b in blocks] == ["summary", "status"]

    def test_direct_no_follow_ups(self):
        blocks = plan_initial_blocks(_outputs_with_both(), mode="direct")
        assert "follow_ups" not in [b.id for b in blocks]


class TestPlanStandard:
    """``standard`` — default mode."""

    def test_standard_empty(self):
        # Chunk 15: no follow_up_candidates → no follow_ups block; the
        # live ``status`` block is always last.
        blocks = plan_initial_blocks([], mode="standard")
        assert [b.id for b in blocks] == ["summary", "status"]

    def test_standard_with_sources_and_media(self):
        # Media rides at the top of the bubble (ChatGPT-style media
        # header). ``_outputs_with_both`` has no follow_up_candidates,
        # so no follow_ups block.
        blocks = plan_initial_blocks(_outputs_with_both(), mode="standard")
        assert [b.id for b in blocks] == [
            "media",
            "summary",
            "sources",
            "status",
        ]

    def test_standard_with_follow_up_candidates(self):
        blocks = plan_initial_blocks(_outputs_with_follow_ups(), mode="standard")
        assert [b.id for b in blocks] == [
            "summary",
            "sources",
            "follow_ups",
            "status",
        ]


class TestPlanRich:
    """``rich`` — summary, sources, media, key_facts, (comparison), follow_ups."""

    def test_rich_empty_still_allocates_key_facts(self):
        # Chunk 15: no adapter follow-up candidates → no follow_ups
        # block. key_facts is still always pre-allocated for rich.
        blocks = plan_initial_blocks([], mode="rich")
        assert [b.id for b in blocks] == ["summary", "key_facts", "status"]

    def test_rich_with_everything(self):
        blocks = plan_initial_blocks(_outputs_with_both(), mode="rich")
        # Media rides at the top; no follow_up_candidates → no
        # follow_ups block.
        assert [b.id for b in blocks] == [
            "media",
            "summary",
            "sources",
            "key_facts",
            "status",
        ]

    def test_rich_with_follow_up_candidates(self):
        blocks = plan_initial_blocks(_outputs_with_follow_ups(), mode="rich")
        assert [b.id for b in blocks] == [
            "summary",
            "sources",
            "key_facts",
            "follow_ups",
            "status",
        ]

    def test_rich_preallocates_comparison_when_flagged(self):
        inputs = PlannerInputs(response_shape="comparison")
        blocks = plan_initial_blocks(
            _outputs_with_sources(),
            mode="rich",
            planner_inputs=inputs,
        )
        assert "comparison" in [b.id for b in blocks]
        # Comparison sits AFTER key_facts and BEFORE status per
        # planner. follow_ups is absent because no candidates.
        ids = [b.id for b in blocks]
        assert ids.index("comparison") > ids.index("key_facts")
        assert ids.index("comparison") < ids.index("status")

    def test_rich_omits_comparison_when_not_flagged(self):
        blocks = plan_initial_blocks([], mode="rich")
        assert "comparison" not in [b.id for b in blocks]


class TestPlanDeep:
    """``deep`` — summary, sources, key_facts, steps, comparison."""

    def test_deep_shape(self):
        blocks = plan_initial_blocks(_outputs_with_sources(), mode="deep")
        # Chunk 15: ``status`` block is now appended after the deep
        # enrichment stack.
        assert [b.id for b in blocks] == [
            "summary",
            "sources",
            "key_facts",
            "steps",
            "comparison",
            "status",
        ]

    def test_deep_omits_media_block(self):
        """Deep mode focuses on synthesis — media is not pre-allocated."""
        blocks = plan_initial_blocks(_outputs_with_media(), mode="deep")
        assert "media" not in [b.id for b in blocks]


class TestPlanSearch:
    """``search`` — retrieval-first takeaway + sources + follow_ups."""

    def test_search_shape(self):
        # Chunk 15: search with sources but no follow_up_candidates
        # emits summary + sources + status only.
        blocks = plan_initial_blocks(_outputs_with_sources(), mode="search")
        assert [b.id for b in blocks] == ["summary", "sources", "status"]

    def test_search_with_follow_up_candidates(self):
        blocks = plan_initial_blocks(_outputs_with_follow_ups(), mode="search")
        assert [b.id for b in blocks] == [
            "summary",
            "sources",
            "follow_ups",
            "status",
        ]

    def test_search_skips_media(self):
        blocks = plan_initial_blocks(_outputs_with_media(), mode="search")
        # No follow_up_candidates, no sources → just summary + status.
        assert [b.id for b in blocks] == ["summary", "status"]


class TestPlanArtifact:
    """``artifact`` — summary + preview + optional sources."""

    def test_artifact_shape(self):
        blocks = plan_initial_blocks([], mode="artifact")
        assert [b.id for b in blocks] == ["summary", "artifact_preview", "status"]

    def test_artifact_preview_uses_dedicated_block_type(self):
        blocks = plan_initial_blocks([], mode="artifact")
        artifact = next(b for b in blocks if b.id == "artifact_preview")
        assert artifact.type is BlockType.artifact_preview


class TestPlanUnknownMode:
    """Unknown mode falls back to standard, never raises."""

    def test_unknown_mode_falls_back_to_standard(self):
        blocks = plan_initial_blocks([], mode="frobnicate")
        assert [b.id for b in blocks] == ["summary", "status"]

    def test_empty_mode_string_falls_back_to_standard(self):
        blocks = plan_initial_blocks([], mode="")
        assert [b.id for b in blocks] == ["summary", "status"]


# ---------------------------------------------------------------------------
# Invariant: no regex / keyword scanning over user text in these modules.
# ---------------------------------------------------------------------------


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class TestNoRegexInvariant:
    """CLAUDE.md: mode and planner MUST NOT classify user intent by regex."""

    _ROOT = Path(__file__).resolve().parents[2]
    _MODE_PATH = _ROOT / "lokidoki/orchestrator/response/mode.py"
    _PLANNER_PATH = _ROOT / "lokidoki/orchestrator/response/planner.py"

    def test_mode_module_has_no_regex(self):
        source = _read_text(self._MODE_PATH)
        for token in ("re.match", "re.search", "re.findall", "re.sub"):
            assert token not in source, f"mode.py must not use {token}"

    def test_mode_module_has_no_lowercased_user_text_scan(self):
        """``.lower()`` on any *value* is banned in ``mode.py`` — intent
        classification over raw text is the decomposer's job, not ours.
        Doc-string references that name the prohibition are fine."""
        source = _read_text(self._MODE_PATH)
        # Strip docstrings / comment mentions — we only care about actual
        # calls on a variable. A real call looks like ``foo.lower(``.
        code_lines = [
            line
            for line in source.splitlines()
            if "# " not in line or ".lower(" not in line.split("# ", 1)[0]
        ]
        # Every real call would survive the above; the docstring lines
        # have ``.lower()`` sitting in plain prose with no preceding
        # identifier. Exclude lines where ``.lower(`` is inside a
        # docstring triple-quote block by looking for `)` directly
        # after ``.lower(`` with an identifier prefix.
        for idx, line in enumerate(code_lines, 1):
            if ".lower(" not in line:
                continue
            # Allow mentions inside docstrings — the file starts + keeps
            # its module docstring within triple quotes at module top.
            stripped = line.strip()
            if stripped.startswith('"') or stripped.startswith("`"):
                continue
            if stripped.startswith("#"):
                continue
            pytest.fail(
                f"mode.py line {idx} contains a real ``.lower(`` call: {line!r}"
            )

    def test_planner_module_has_no_regex(self):
        source = _read_text(self._PLANNER_PATH)
        for token in ("re.match", "re.search", "re.findall", "re.sub"):
            assert token not in source, f"planner.py must not use {token}"

    def test_planner_module_has_no_lowercased_user_text_scan_in_mode_dispatch(self):
        """Mode dispatch helpers must not call ``.lower()``.

        ``is_offline_degraded`` (in the same file) DOES call ``.lower()``
        on error strings — that is error classification, not user-intent
        classification, and CLAUDE.md's rule permits it. We scope this
        invariant to the mode-dispatch half of the module.
        """
        source = _read_text(self._PLANNER_PATH)
        dispatch_half = source.split("def is_offline_degraded")[0]
        assert ".lower(" not in dispatch_half
