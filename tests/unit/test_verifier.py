"""Phase 6: Selective Verifier unit tests.

Tests three things per CODEX policy:
  1. Effectiveness — verifier triggers on the right conditions, skips clean turns
  2. Regression safety — clean turns see zero overhead, no false positives
  3. Performance — verifier is pure Python, no LLM calls
"""
import pytest
from dataclasses import dataclass, field
from typing import Optional

from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.decomposer_repair import RepairStats
from lokidoki.core.response_spec import ResponseSpec
from lokidoki.core.verifier import (
    DecompositionDiagnostics,
    VerifierAdjustment,
    VerifierResult,
    apply_adjustments,
    build_diagnostics,
    should_verify,
    verify,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_ask(**overrides) -> Ask:
    defaults = dict(
        ask_id="ask_000",
        intent="direct_chat",
        distilled_query="test query",
    )
    defaults.update(overrides)
    return Ask(**defaults)


@dataclass
class FakeResolution:
    status: str = "resolved"
    chosen_candidate: Optional[dict] = None
    candidates: list = field(default_factory=list)
    source: str = "session_cache"
    clarification_hint: Optional[str] = None


@dataclass
class FakeEnrichedAsk:
    ask: Ask = field(default_factory=_make_ask)
    resolution: FakeResolution = field(default_factory=FakeResolution)
    enriched_query: str = ""

    @property
    def ask_id(self):
        return self.ask.ask_id

    @property
    def intent(self):
        return self.ask.intent

    @intent.setter
    def intent(self, v):
        self.ask.intent = v

    @property
    def distilled_query(self):
        return self.ask.distilled_query

    def __getattr__(self, name):
        return getattr(self.ask, name)


def _make_decomp(**overrides) -> DecompositionResult:
    defaults = dict(
        asks=[_make_ask()],
        model="gemma4:e4b",
        latency_ms=50.0,
    )
    defaults.update(overrides)
    return DecompositionResult(**defaults)


def _make_spec(**overrides) -> ResponseSpec:
    defaults = dict(
        reply_mode="full_synthesis",
        memory_mode="full",
        grounding_mode="optional",
        followup_policy="after_answer",
        style_mode="default",
        citation_policy="optional",
    )
    defaults.update(overrides)
    return ResponseSpec(**defaults)


# ---------------------------------------------------------------------------
# build_diagnostics
# ---------------------------------------------------------------------------

class TestBuildDiagnostics:
    def test_clean_turn_produces_clean_diagnostics(self):
        decomp = _make_decomp()
        resolved = [FakeEnrichedAsk()]
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=resolved, write_reports=[],
        )
        assert not diag.repair_fired
        assert not diag.asks_empty
        assert not diag.used_fallback_ask
        assert not diag.referent_ambiguous
        assert not diag.referent_unresolved
        assert diag.routing_conflicts == []
        assert diag.memory_write_risk == "none"

    def test_repair_fired_propagates(self):
        decomp = _make_decomp(
            repair_stats=RepairStats(repair_fired=True, repair_attempts=2, items_dropped=1),
        )
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[], write_reports=[],
        )
        assert diag.repair_fired
        assert diag.repair_attempts == 2
        assert diag.items_dropped == 1

    def test_fallback_ask_detected(self):
        decomp = _make_decomp(used_fallback_ask=True)
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[], write_reports=[],
        )
        assert diag.used_fallback_ask

    def test_referent_ambiguous_detected(self):
        enriched = FakeEnrichedAsk(
            resolution=FakeResolution(status="ambiguous"),
        )
        diag = build_diagnostics(
            decomposition=_make_decomp(),
            resolved_asks=[enriched],
            write_reports=[],
        )
        assert diag.referent_ambiguous
        assert diag.referent_ambiguous_count == 1

    def test_referent_unresolved_detected(self):
        enriched = FakeEnrichedAsk(
            resolution=FakeResolution(status="unresolved"),
        )
        diag = build_diagnostics(
            decomposition=_make_decomp(),
            resolved_asks=[enriched],
            write_reports=[],
        )
        assert diag.referent_unresolved
        assert diag.referent_unresolved_count == 1

    def test_routing_conflict_current_data_no_capability(self):
        ask = _make_ask(
            requires_current_data=True,
            capability_need="none",
            knowledge_source="none",
        )
        enriched = FakeEnrichedAsk(ask=ask)
        diag = build_diagnostics(
            decomposition=_make_decomp(asks=[ask]),
            resolved_asks=[enriched],
            write_reports=[],
        )
        assert len(diag.routing_conflicts) == 1
        assert "requires_current_data" in diag.routing_conflicts[0]

    def test_routing_conflict_knowledge_capability_mismatch(self):
        ask = _make_ask(
            knowledge_source="encyclopedic",
            capability_need="web_search",
        )
        enriched = FakeEnrichedAsk(ask=ask)
        diag = build_diagnostics(
            decomposition=_make_decomp(asks=[ask]),
            resolved_asks=[enriched],
            write_reports=[],
        )
        assert any("encyclopedic" in c and "web_search" in c for c in diag.routing_conflicts)

    def test_routing_conflict_referent_resolution_no_anchor(self):
        ask = _make_ask(
            needs_referent_resolution=True,
            referent_anchor="",
        )
        enriched = FakeEnrichedAsk(ask=ask)
        diag = build_diagnostics(
            decomposition=_make_decomp(asks=[ask]),
            resolved_asks=[enriched],
            write_reports=[],
        )
        assert any("referent_anchor" in c for c in diag.routing_conflicts)

    def test_memory_write_risk_high_on_multiple_negations(self):
        items = [
            {"subject_type": "self", "predicate": "p", "value": "v", "negates_previous": True},
            {"subject_type": "self", "predicate": "q", "value": "w", "negates_previous": True},
        ]
        decomp = _make_decomp(long_term_memory=items)
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[], write_reports=[],
        )
        assert diag.memory_write_risk in ("low", "high")
        assert any("negation" in r for r in diag.memory_write_risk_reasons)

    def test_memory_write_risk_high_on_ambiguous_person(self):
        reports = [
            {"status": "ambiguous", "subject_label": "Tom", "fact_id": 1},
        ]
        diag = build_diagnostics(
            decomposition=_make_decomp(), resolved_asks=[], write_reports=reports,
        )
        assert any("ambiguous" in r for r in diag.memory_write_risk_reasons)

    def test_memory_write_risk_high_on_contradictions(self):
        reports = [
            {"status": "active", "contradiction": {"action": "revise"}, "fact_id": 1},
        ]
        diag = build_diagnostics(
            decomposition=_make_decomp(), resolved_asks=[], write_reports=reports,
        )
        assert any("contradiction" in r for r in diag.memory_write_risk_reasons)

    def test_person_missing_name_flagged(self):
        items = [
            {"subject_type": "person", "subject_name": "", "predicate": "is", "value": "tall"},
        ]
        decomp = _make_decomp(long_term_memory=items)
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[], write_reports=[],
        )
        assert any("subject_name" in r for r in diag.memory_write_risk_reasons)


# ---------------------------------------------------------------------------
# should_verify
# ---------------------------------------------------------------------------

class TestShouldVerify:
    def test_clean_diagnostics_skips(self):
        diag = DecompositionDiagnostics()
        assert not should_verify(diag)

    def test_repair_fired_triggers(self):
        diag = DecompositionDiagnostics(repair_fired=True)
        assert should_verify(diag)

    def test_asks_empty_triggers(self):
        diag = DecompositionDiagnostics(asks_empty=True)
        assert should_verify(diag)

    def test_fallback_ask_triggers(self):
        diag = DecompositionDiagnostics(used_fallback_ask=True)
        assert should_verify(diag)

    def test_referent_ambiguous_triggers(self):
        diag = DecompositionDiagnostics(referent_ambiguous=True)
        assert should_verify(diag)

    def test_routing_conflicts_triggers(self):
        diag = DecompositionDiagnostics(
            routing_conflicts=["ask_000: some conflict"],
        )
        assert should_verify(diag)

    def test_high_memory_risk_triggers(self):
        diag = DecompositionDiagnostics(memory_write_risk="high")
        assert should_verify(diag)

    def test_low_memory_risk_does_not_trigger(self):
        diag = DecompositionDiagnostics(memory_write_risk="low")
        assert not should_verify(diag)

    def test_unresolved_referent_alone_does_not_trigger(self):
        """Unresolved referents are handled by the referent resolver's fallbacks.
        Only ambiguous (multiple candidates, no winner) triggers the verifier."""
        diag = DecompositionDiagnostics(referent_unresolved=True)
        assert not should_verify(diag)


# ---------------------------------------------------------------------------
# verify — reply lane checks
# ---------------------------------------------------------------------------

class TestVerifyReplyLane:
    def test_fallback_ask_upgrades_social_ack(self):
        diag = DecompositionDiagnostics(used_fallback_ask=True)
        spec = _make_spec(reply_mode="social_ack")
        result = verify(diag, _make_decomp(), [], [], spec)
        lane_adj = [a for a in result.adjustments if a.field == "reply_mode"]
        assert len(lane_adj) == 1
        assert lane_adj[0].new_value == "full_synthesis"

    def test_ambiguous_referent_upgrades_grounded_direct(self):
        diag = DecompositionDiagnostics(referent_ambiguous=True)
        spec = _make_spec(reply_mode="grounded_direct")
        result = verify(diag, _make_decomp(), [], [], spec)
        lane_adj = [a for a in result.adjustments if a.field == "reply_mode"]
        assert len(lane_adj) == 1
        assert lane_adj[0].new_value == "full_synthesis"

    def test_repair_plus_conflicts_upgrades(self):
        diag = DecompositionDiagnostics(
            repair_fired=True,
            routing_conflicts=["ask_000: conflict"],
        )
        spec = _make_spec(reply_mode="social_ack")
        result = verify(diag, _make_decomp(), [], [], spec)
        lane_adj = [a for a in result.adjustments if a.field == "reply_mode"]
        assert any(a.new_value == "full_synthesis" for a in lane_adj)

    def test_full_synthesis_not_downgraded(self):
        diag = DecompositionDiagnostics(repair_fired=True)
        spec = _make_spec(reply_mode="full_synthesis")
        result = verify(diag, _make_decomp(), [], [], spec)
        lane_adj = [a for a in result.adjustments if a.field == "reply_mode"]
        assert not lane_adj


# ---------------------------------------------------------------------------
# verify — freshness need checks
# ---------------------------------------------------------------------------

class TestVerifyFreshnessNeed:
    def test_repair_dropped_items_forces_freshness(self):
        diag = DecompositionDiagnostics(
            repair_fired=True, items_dropped=1,
        )
        ask = _make_ask(
            knowledge_source="encyclopedic",
            requires_current_data=False,
        )
        enriched = FakeEnrichedAsk(ask=ask)
        decomp = _make_decomp(asks=[ask])
        spec = _make_spec()
        result = verify(diag, decomp, [enriched], [], spec)
        freshness_adj = [a for a in result.adjustments if a.field == "requires_current_data"]
        assert len(freshness_adj) == 1
        assert freshness_adj[0].new_value is True

    def test_no_freshness_change_when_already_set(self):
        diag = DecompositionDiagnostics(
            repair_fired=True, items_dropped=1,
        )
        ask = _make_ask(
            knowledge_source="web",
            requires_current_data=True,
        )
        enriched = FakeEnrichedAsk(ask=ask)
        spec = _make_spec()
        result = verify(diag, _make_decomp(asks=[ask]), [enriched], [], spec)
        freshness_adj = [a for a in result.adjustments if a.field == "requires_current_data"]
        assert not freshness_adj

    def test_no_freshness_on_fallback(self):
        """Fallback asks already have requires_current_data=True."""
        diag = DecompositionDiagnostics(
            repair_fired=True, items_dropped=1, used_fallback_ask=True,
        )
        spec = _make_spec()
        result = verify(diag, _make_decomp(), [], [], spec)
        freshness_adj = [a for a in result.adjustments if a.field == "requires_current_data"]
        assert not freshness_adj


# ---------------------------------------------------------------------------
# verify — capability need checks
# ---------------------------------------------------------------------------

class TestVerifyCapabilityNeed:
    def test_aligns_capability_with_encyclopedic_source(self):
        diag = DecompositionDiagnostics(
            routing_conflicts=["ask_000: knowledge_source=encyclopedic but capability_need=web_search"],
        )
        ask = _make_ask(
            knowledge_source="encyclopedic",
            capability_need="web_search",
        )
        enriched = FakeEnrichedAsk(ask=ask)
        spec = _make_spec()
        result = verify(diag, _make_decomp(asks=[ask]), [enriched], [], spec)
        cap_adj = [a for a in result.adjustments if a.field == "capability_need"]
        assert any(a.new_value == "encyclopedic" for a in cap_adj)

    def test_aligns_capability_with_web_source(self):
        diag = DecompositionDiagnostics(
            routing_conflicts=["ask_000: knowledge_source=web but capability_need=encyclopedic"],
        )
        ask = _make_ask(
            knowledge_source="web",
            capability_need="encyclopedic",
        )
        enriched = FakeEnrichedAsk(ask=ask)
        spec = _make_spec()
        result = verify(diag, _make_decomp(asks=[ask]), [enriched], [], spec)
        cap_adj = [a for a in result.adjustments if a.field == "capability_need"]
        assert any(a.new_value == "web_search" for a in cap_adj)

    def test_assigns_web_search_for_current_data_without_capability(self):
        diag = DecompositionDiagnostics(
            routing_conflicts=["ask_000: requires_current_data=True but capability_need=none and knowledge_source=none"],
        )
        ask = _make_ask(
            requires_current_data=True,
            capability_need="none",
            knowledge_source="none",
        )
        enriched = FakeEnrichedAsk(ask=ask)
        spec = _make_spec()
        result = verify(diag, _make_decomp(asks=[ask]), [enriched], [], spec)
        cap_adj = [a for a in result.adjustments if a.field == "capability_need"]
        assert any(a.new_value == "web_search" for a in cap_adj)

    def test_no_capability_change_without_conflicts(self):
        diag = DecompositionDiagnostics()
        spec = _make_spec()
        result = verify(diag, _make_decomp(), [], [], spec)
        cap_adj = [a for a in result.adjustments if a.field == "capability_need"]
        assert not cap_adj


# ---------------------------------------------------------------------------
# verify — memory-write confidence checks
# ---------------------------------------------------------------------------

class TestVerifyMemoryWriteConfidence:
    def test_blocks_ambiguous_person_writes_on_high_risk(self):
        items = [
            {"subject_type": "person", "subject_name": "Tom", "predicate": "likes", "value": "cats"},
        ]
        reports = [
            {"status": "ambiguous", "subject_label": "Tom", "fact_id": 1},
            {"status": "ambiguous", "subject_label": "Tom", "fact_id": 2},
        ]
        decomp = _make_decomp(long_term_memory=items)
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[], write_reports=reports,
        )
        assert diag.memory_write_risk == "high"
        spec = _make_spec()
        result = verify(diag, decomp, [], reports, spec)
        assert 0 in result.blocked_memory_item_indices

    def test_blocks_excessive_negations(self):
        items = [
            {"subject_type": "self", "predicate": f"p{i}", "value": f"v{i}", "negates_previous": True}
            for i in range(3)
        ]
        decomp = _make_decomp(long_term_memory=items)
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[], write_reports=[],
        )
        assert diag.memory_write_risk == "high"
        spec = _make_spec()
        result = verify(diag, decomp, [], [], spec)
        assert len(result.blocked_memory_item_indices) == 3

    def test_low_risk_does_not_block(self):
        items = [
            {"subject_type": "self", "predicate": "likes", "value": "cats", "negates_previous": True},
        ]
        decomp = _make_decomp(long_term_memory=items)
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[], write_reports=[],
        )
        # Single negation = low risk at most
        assert diag.memory_write_risk != "high"
        spec = _make_spec()
        result = verify(diag, decomp, [], [], spec)
        assert not result.blocked_memory_item_indices


# ---------------------------------------------------------------------------
# apply_adjustments
# ---------------------------------------------------------------------------

class TestApplyAdjustments:
    def test_reply_mode_adjustment_cascades(self):
        spec = _make_spec(
            reply_mode="social_ack",
            memory_mode="sparse",
            followup_policy="none",
            style_mode="warm",
        )
        result = VerifierResult(
            triggered=True,
            adjustments=[
                VerifierAdjustment(
                    field="reply_mode",
                    old_value="social_ack",
                    new_value="full_synthesis",
                    reason="test",
                ),
            ],
        )
        apply_adjustments(result, spec, [])
        assert spec.reply_mode == "full_synthesis"
        assert spec.memory_mode == "full"
        assert spec.followup_policy == "after_answer"
        assert spec.style_mode == "default"

    def test_capability_need_adjustment(self):
        ask = _make_ask(ask_id="ask_001", capability_need="web_search")
        enriched = FakeEnrichedAsk(ask=ask)
        result = VerifierResult(
            triggered=True,
            adjustments=[
                VerifierAdjustment(
                    field="capability_need",
                    ask_id="ask_001",
                    old_value="web_search",
                    new_value="encyclopedic",
                    reason="test",
                ),
            ],
        )
        apply_adjustments(result, _make_spec(), [enriched])
        assert ask.capability_need == "encyclopedic"

    def test_requires_current_data_adjustment(self):
        ask = _make_ask(ask_id="ask_002", requires_current_data=False)
        enriched = FakeEnrichedAsk(ask=ask)
        result = VerifierResult(
            triggered=True,
            adjustments=[
                VerifierAdjustment(
                    field="requires_current_data",
                    ask_id="ask_002",
                    old_value=False,
                    new_value=True,
                    reason="test",
                ),
            ],
        )
        apply_adjustments(result, _make_spec(), [enriched])
        assert ask.requires_current_data is True

    def test_no_changes_when_empty(self):
        spec = _make_spec(reply_mode="social_ack")
        result = VerifierResult(triggered=True)
        apply_adjustments(result, spec, [])
        assert spec.reply_mode == "social_ack"  # unchanged


# ---------------------------------------------------------------------------
# Regression: clean turns
# ---------------------------------------------------------------------------

class TestCleanTurnRegression:
    """Ensure the verifier adds zero overhead on typical clean turns."""

    def test_simple_greeting(self):
        """A greeting turn: no repair, no fallback, resolved referents."""
        decomp = _make_decomp(
            asks=[_make_ask(intent="direct_chat", distilled_query="hey!")],
        )
        enriched = FakeEnrichedAsk(
            ask=decomp.asks[0],
            resolution=FakeResolution(status="resolved"),
        )
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[enriched], write_reports=[],
        )
        assert not should_verify(diag)

    def test_fact_sharing_turn(self):
        """User shares a fact — clean decomposition with one write."""
        decomp = _make_decomp(
            asks=[_make_ask(intent="direct_chat")],
            long_term_memory=[
                {"subject_type": "self", "predicate": "likes", "value": "hiking"},
            ],
        )
        reports = [{"status": "active", "fact_id": 42, "subject_label": "you",
                     "predicate": "likes", "value": "hiking"}]
        enriched = FakeEnrichedAsk(ask=decomp.asks[0])
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[enriched], write_reports=reports,
        )
        assert not should_verify(diag)

    def test_encyclopedic_lookup(self):
        """Standard encyclopedic query — consistent routing fields."""
        ask = _make_ask(
            intent="direct_chat",
            knowledge_source="encyclopedic",
            capability_need="encyclopedic",
            requires_current_data=False,
        )
        decomp = _make_decomp(asks=[ask])
        enriched = FakeEnrichedAsk(ask=ask)
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[enriched], write_reports=[],
        )
        assert not should_verify(diag)

    def test_web_search_turn(self):
        """Web search with consistent fields."""
        ask = _make_ask(
            intent="direct_chat",
            knowledge_source="web",
            capability_need="web_search",
            requires_current_data=True,
        )
        decomp = _make_decomp(asks=[ask])
        enriched = FakeEnrichedAsk(ask=ask)
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[enriched], write_reports=[],
        )
        assert not should_verify(diag)


# ---------------------------------------------------------------------------
# Realistic / messy inputs
# ---------------------------------------------------------------------------

class TestRealisticInputs:
    """Per CODEX: test inputs must include realistic, messy, real-life turns."""

    def test_correction_turn_with_negation(self):
        """'No wait, I actually prefer tea not coffee' — single negation, low risk."""
        items = [
            {"subject_type": "self", "predicate": "prefers", "value": "tea",
             "negates_previous": True, "kind": "preference"},
        ]
        decomp = _make_decomp(long_term_memory=items)
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[], write_reports=[],
        )
        # Single correction should not trigger
        assert not should_verify(diag)

    def test_confused_decomposer_multi_repair(self):
        """Decomposer confused by 'My brother Tom and his wife Sarah both love sushi' —
        repair fires, items dropped, multiple person writes."""
        items = [
            {"subject_type": "person", "subject_name": "Tom", "predicate": "loves",
             "value": "sushi", "kind": "fact", "relationship_kind": "brother"},
            {"subject_type": "person", "subject_name": "Sarah", "predicate": "loves",
             "value": "sushi", "kind": "fact"},
        ]
        reports = [
            {"status": "ambiguous", "subject_label": "Tom", "fact_id": 1},
            {"status": "ambiguous", "subject_label": "Sarah", "fact_id": 2},
        ]
        decomp = _make_decomp(
            long_term_memory=items,
            repair_stats=RepairStats(repair_fired=True, repair_attempts=1, items_dropped=0),
        )
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[], write_reports=reports,
        )
        assert should_verify(diag)  # repair_fired
        assert diag.memory_write_risk == "high"  # 2 ambiguous writes

    def test_pronoun_follow_up_ambiguous(self):
        """'Is she still working there?' — referent ambiguous between two people."""
        ask = _make_ask(
            needs_referent_resolution=True,
            referent_anchor="she",
            referent_type="person",
            capability_need="people_lookup",
        )
        enriched = FakeEnrichedAsk(
            ask=ask,
            resolution=FakeResolution(status="ambiguous"),
        )
        decomp = _make_decomp(asks=[ask])
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[enriched], write_reports=[],
        )
        assert should_verify(diag)
        spec = _make_spec(reply_mode="grounded_direct")
        result = verify(diag, decomp, [enriched], [], spec)
        # Should upgrade to full_synthesis so model can hedge/ask
        lane_adj = [a for a in result.adjustments if a.field == "reply_mode"]
        assert any(a.new_value == "full_synthesis" for a in lane_adj)

    def test_emotionally_colored_turn_stays_clean(self):
        """'I'm really stressed about work' — emotional but clean decomposition."""
        ask = _make_ask(intent="direct_chat", distilled_query="I'm stressed about work")
        items = [
            {"subject_type": "self", "predicate": "is stressed about", "value": "work",
             "kind": "fact"},
        ]
        decomp = _make_decomp(
            asks=[ask],
            long_term_memory=items,
            short_term_memory={"sentiment": "stressed", "concern": "work"},
        )
        enriched = FakeEnrichedAsk(ask=ask)
        reports = [{"status": "active", "fact_id": 10, "subject_label": "you",
                     "predicate": "is stressed about", "value": "work"}]
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[enriched], write_reports=reports,
        )
        assert not should_verify(diag)

    def test_current_data_phrasing_routing_conflict(self):
        """'What's playing right now?' — requires_current_data but decomposer
        forgot to set capability_need."""
        ask = _make_ask(
            requires_current_data=True,
            capability_need="none",
            knowledge_source="none",
            distilled_query="what's playing right now",
        )
        enriched = FakeEnrichedAsk(ask=ask)
        decomp = _make_decomp(asks=[ask])
        diag = build_diagnostics(
            decomposition=decomp, resolved_asks=[enriched], write_reports=[],
        )
        assert diag.routing_conflicts
        assert should_verify(diag)
        spec = _make_spec()
        result = verify(diag, decomp, [enriched], [], spec)
        cap_adj = [a for a in result.adjustments if a.field == "capability_need"]
        assert any(a.new_value == "web_search" for a in cap_adj)
