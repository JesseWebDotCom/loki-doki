"""Phase 6: Selective Verifier and Memory-Write Risk Checks.

A second-pass safety net that fires only when decomposition diagnostics
indicate uncertainty. Clean turns skip it entirely — zero overhead on
the happy path. When triggered, the verifier re-evaluates four things:

  1. reply lane — is the planned routing appropriate?
  2. freshness need — should ``requires_current_data`` be forced?
  3. capability need — is the capability assignment consistent?
  4. memory-write confidence — should risky writes be blocked/downgraded?

All checks are deterministic (no LLM call). The verifier emits
adjustments; the orchestrator applies them before skill routing.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.decomposer_repair import RepairStats

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Diagnostics — assembled from pipeline signals
# ---------------------------------------------------------------------------

@dataclass
class DecompositionDiagnostics:
    """Quality signals gathered after decomposition + referent resolution."""

    # Repair-loop signals
    repair_fired: bool = False
    repair_attempts: int = 0
    items_dropped: int = 0
    items_coerced: int = 0

    # Ask-level signals
    asks_empty: bool = False
    used_fallback_ask: bool = False

    # Referent resolution signals
    referent_ambiguous: bool = False
    referent_unresolved: bool = False
    referent_ambiguous_count: int = 0
    referent_unresolved_count: int = 0

    # Routing consistency
    routing_conflicts: list[str] = field(default_factory=list)

    # Memory-write risk
    memory_write_risk: str = "none"  # "none" | "low" | "high"
    memory_write_risk_reasons: list[str] = field(default_factory=list)


def build_diagnostics(
    *,
    decomposition: DecompositionResult,
    resolved_asks: list[Any],
    write_reports: list[dict],
) -> DecompositionDiagnostics:
    """Assemble diagnostics from pipeline state. Pure function."""
    stats: RepairStats = decomposition.repair_stats
    diag = DecompositionDiagnostics(
        repair_fired=stats.repair_fired,
        repair_attempts=stats.repair_attempts,
        items_dropped=stats.items_dropped,
        items_coerced=stats.items_coerced,
        asks_empty=not decomposition.asks,
        used_fallback_ask=decomposition.used_fallback_ask,
    )

    # --- referent resolution signals ---
    for a in resolved_asks:
        status = getattr(getattr(a, "resolution", None), "status", "none")
        if status == "ambiguous":
            diag.referent_ambiguous = True
            diag.referent_ambiguous_count += 1
        elif status == "unresolved":
            diag.referent_unresolved = True
            diag.referent_unresolved_count += 1

    # --- routing field conflicts ---
    for a in (resolved_asks or decomposition.asks or []):
        ask = getattr(a, "ask", a) if hasattr(a, "ask") else a
        _check_routing_conflicts(ask, diag.routing_conflicts)

    # --- memory-write risk ---
    _assess_memory_write_risk(decomposition, write_reports, diag)

    return diag


def _check_routing_conflicts(ask: Ask, conflicts: list[str]) -> None:
    """Flag inconsistencies between routing fields on a single ask."""
    aid = getattr(ask, "ask_id", "?")

    # requires_current_data without a capability to satisfy it
    if (
        getattr(ask, "requires_current_data", False)
        and getattr(ask, "capability_need", "none") == "none"
        and getattr(ask, "knowledge_source", "none") == "none"
    ):
        conflicts.append(
            f"{aid}: requires_current_data=True but capability_need=none "
            f"and knowledge_source=none"
        )

    # knowledge_source / capability_need mismatch
    ks = getattr(ask, "knowledge_source", "none")
    cn = getattr(ask, "capability_need", "none")
    if ks == "encyclopedic" and cn == "web_search":
        conflicts.append(
            f"{aid}: knowledge_source=encyclopedic but capability_need=web_search"
        )
    if ks == "web" and cn == "encyclopedic":
        conflicts.append(
            f"{aid}: knowledge_source=web but capability_need=encyclopedic"
        )

    # needs_referent_resolution without an anchor
    if (
        getattr(ask, "needs_referent_resolution", False)
        and not (getattr(ask, "referent_anchor", "") or "").strip()
    ):
        conflicts.append(
            f"{aid}: needs_referent_resolution=True but referent_anchor is empty"
        )


def _assess_memory_write_risk(
    decomposition: DecompositionResult,
    write_reports: list[dict],
    diag: DecompositionDiagnostics,
) -> None:
    """Set memory_write_risk and reasons on the diagnostics."""
    reasons: list[str] = []

    # Negation-heavy turns: the decomposer flagged multiple corrections
    negation_count = sum(
        1 for item in (decomposition.long_term_memory or [])
        if item.get("negates_previous")
    )
    if negation_count >= 2:
        reasons.append(f"high negation count ({negation_count})")

    # Ambiguous person resolution
    ambiguous_writes = sum(
        1 for r in write_reports
        if r and r.get("status") == "ambiguous"
    )
    if ambiguous_writes:
        reasons.append(f"ambiguous person resolution ({ambiguous_writes} writes)")

    # Person item without subject_name — should have been caught by repair
    # but defense-in-depth
    for item in decomposition.long_term_memory or []:
        if (
            item.get("subject_type") == "person"
            and not (item.get("subject_name") or "").strip()
        ):
            reasons.append("person item missing subject_name")
            break

    # Contradiction detected during upsert
    contradiction_count = sum(
        1 for r in write_reports
        if r and (r.get("contradiction") or {}).get("action") in ("revise", "reject")
    )
    if contradiction_count:
        reasons.append(f"contradictions detected ({contradiction_count})")

    # Repair loop dropped items — model was confused about facts
    if diag.items_dropped > 0:
        reasons.append(f"repair dropped {diag.items_dropped} items")

    diag.memory_write_risk_reasons = reasons
    if not reasons:
        diag.memory_write_risk = "none"
    elif len(reasons) >= 2 or ambiguous_writes >= 2 or negation_count >= 3:
        diag.memory_write_risk = "high"
    else:
        diag.memory_write_risk = "low"


# ---------------------------------------------------------------------------
# Verifier — the second-pass safety net
# ---------------------------------------------------------------------------

@dataclass
class VerifierAdjustment:
    """A single correction the verifier wants to apply."""
    field: str          # e.g. "reply_mode", "requires_current_data", "memory_write_block"
    ask_id: str = ""    # empty for turn-level adjustments
    old_value: Any = None
    new_value: Any = None
    reason: str = ""


@dataclass
class VerifierResult:
    """Output of the selective verifier."""
    triggered: bool = False
    adjustments: list[VerifierAdjustment] = field(default_factory=list)
    diagnostics: Optional[DecompositionDiagnostics] = None
    blocked_memory_item_indices: list[int] = field(default_factory=list)

    @property
    def made_changes(self) -> bool:
        return bool(self.adjustments) or bool(self.blocked_memory_item_indices)


def should_verify(diag: DecompositionDiagnostics) -> bool:
    """Decide whether the verifier should run. Fast check — O(1)."""
    return (
        diag.repair_fired
        or diag.asks_empty
        or diag.used_fallback_ask
        or diag.referent_ambiguous
        or bool(diag.routing_conflicts)
        or diag.memory_write_risk == "high"
    )


def verify(
    diag: DecompositionDiagnostics,
    decomposition: DecompositionResult,
    resolved_asks: list[Any],
    write_reports: list[dict],
    response_spec: Any,
) -> VerifierResult:
    """Run the selective verifier. Only call when ``should_verify`` is True.

    Checks four concerns:
      1. Reply lane appropriateness
      2. Freshness need
      3. Capability need consistency
      4. Memory-write confidence
    """
    result = VerifierResult(triggered=True, diagnostics=diag)

    _check_reply_lane(diag, decomposition, resolved_asks, response_spec, result)
    _check_freshness_need(diag, decomposition, resolved_asks, result)
    _check_capability_need(diag, resolved_asks, result)
    _check_memory_write_confidence(diag, decomposition, write_reports, result)

    if result.adjustments or result.blocked_memory_item_indices:
        logger.info(
            "[verifier] %d adjustments, %d blocked writes: %s",
            len(result.adjustments),
            len(result.blocked_memory_item_indices),
            [(a.field, a.reason) for a in result.adjustments],
        )
    else:
        logger.debug("[verifier] triggered but no adjustments needed")

    return result


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------

def _check_reply_lane(
    diag: DecompositionDiagnostics,
    decomposition: DecompositionResult,
    resolved_asks: list[Any],
    response_spec: Any,
    result: VerifierResult,
) -> None:
    """Verify the planned reply lane is appropriate given diagnostics."""
    planned_lane = getattr(response_spec, "reply_mode", "full_synthesis")

    # Fallback asks should never route to social_ack — they need real work.
    if diag.used_fallback_ask and planned_lane == "social_ack":
        result.adjustments.append(VerifierAdjustment(
            field="reply_mode",
            old_value="social_ack",
            new_value="full_synthesis",
            reason="fallback ask should not route to social_ack",
        ))

    # Ambiguous referent with grounded_direct is risky — the answer may
    # target the wrong entity. Upgrade to full_synthesis so the model
    # can hedge or ask.
    if diag.referent_ambiguous and planned_lane == "grounded_direct":
        result.adjustments.append(VerifierAdjustment(
            field="reply_mode",
            old_value="grounded_direct",
            new_value="full_synthesis",
            reason="ambiguous referent — grounded_direct may target wrong entity",
        ))

    # Heavy repair + routing conflicts suggest the decomposer was confused.
    # Don't trust a grounded_direct or social_ack routing in that case.
    if (
        diag.repair_fired
        and diag.routing_conflicts
        and planned_lane in ("grounded_direct", "social_ack")
    ):
        result.adjustments.append(VerifierAdjustment(
            field="reply_mode",
            old_value=planned_lane,
            new_value="full_synthesis",
            reason="repair + routing conflicts — decomposer confused",
        ))


def _check_freshness_need(
    diag: DecompositionDiagnostics,
    decomposition: DecompositionResult,
    resolved_asks: list[Any],
    result: VerifierResult,
) -> None:
    """Check if requires_current_data should be forced on any ask."""
    # When a fallback ask was generated, it already has requires_current_data=True.
    # But when repair fired AND the original asks don't have freshness set,
    # the decomposer may have dropped a current-data signal during repair.
    if not diag.repair_fired or diag.used_fallback_ask:
        return

    for a in resolved_asks:
        ask = getattr(a, "ask", a) if hasattr(a, "ask") else a
        # If repair dropped items AND this ask targets an external source
        # but doesn't flag current data — the decomposer likely lost the
        # signal during its confused output.
        if (
            diag.items_dropped > 0
            and getattr(ask, "knowledge_source", "none") != "none"
            and not getattr(ask, "requires_current_data", False)
        ):
            result.adjustments.append(VerifierAdjustment(
                field="requires_current_data",
                ask_id=getattr(ask, "ask_id", ""),
                old_value=False,
                new_value=True,
                reason="repair dropped items + external source — forcing freshness",
            ))


def _check_capability_need(
    diag: DecompositionDiagnostics,
    resolved_asks: list[Any],
    result: VerifierResult,
) -> None:
    """Fix capability_need when routing conflicts were detected."""
    if not diag.routing_conflicts:
        return

    for a in resolved_asks:
        ask = getattr(a, "ask", a) if hasattr(a, "ask") else a
        aid = getattr(ask, "ask_id", "?")
        ks = getattr(ask, "knowledge_source", "none")
        cn = getattr(ask, "capability_need", "none")

        # knowledge_source wins when they disagree — it's the higher-level
        # semantic signal from the decomposer.
        if ks == "encyclopedic" and cn == "web_search":
            result.adjustments.append(VerifierAdjustment(
                field="capability_need",
                ask_id=aid,
                old_value="web_search",
                new_value="encyclopedic",
                reason="aligning capability_need with knowledge_source=encyclopedic",
            ))
        elif ks == "web" and cn == "encyclopedic":
            result.adjustments.append(VerifierAdjustment(
                field="capability_need",
                ask_id=aid,
                old_value="encyclopedic",
                new_value="web_search",
                reason="aligning capability_need with knowledge_source=web",
            ))

        # requires_current_data but no capability → assign web_search
        if (
            getattr(ask, "requires_current_data", False)
            and cn == "none"
            and ks == "none"
        ):
            result.adjustments.append(VerifierAdjustment(
                field="capability_need",
                ask_id=aid,
                old_value="none",
                new_value="web_search",
                reason="requires_current_data without capability — assigning web_search",
            ))


def _check_memory_write_confidence(
    diag: DecompositionDiagnostics,
    decomposition: DecompositionResult,
    write_reports: list[dict],
    result: VerifierResult,
) -> None:
    """Block or flag memory writes when risk is high."""
    if diag.memory_write_risk != "high":
        return

    items = decomposition.long_term_memory or []
    for i, item in enumerate(items):
        # Block person writes with ambiguous resolution — the fact would
        # pollute the wrong person's profile.
        if (
            item.get("subject_type") == "person"
            and any(
                r.get("status") == "ambiguous"
                and r.get("subject_label", "").lower() == (item.get("subject_name") or "").lower()
                for r in write_reports
                if r
            )
        ):
            result.blocked_memory_item_indices.append(i)
            result.adjustments.append(VerifierAdjustment(
                field="memory_write_block",
                ask_id="",
                old_value="active",
                new_value="blocked",
                reason=f"high-risk person write for '{item.get('subject_name')}' "
                       f"with ambiguous resolution",
            ))

        # Block negation writes when multiple contradictions detected —
        # the model may be hallucinating corrections.
        if (
            item.get("negates_previous")
            and sum(1 for it in items if it.get("negates_previous")) >= 3
        ):
            if i not in result.blocked_memory_item_indices:
                result.blocked_memory_item_indices.append(i)
                result.adjustments.append(VerifierAdjustment(
                    field="memory_write_block",
                    ask_id="",
                    old_value="active",
                    new_value="blocked",
                    reason="excessive negations — likely hallucinated corrections",
                ))


# ---------------------------------------------------------------------------
# Applying verifier adjustments
# ---------------------------------------------------------------------------

def apply_adjustments(
    result: VerifierResult,
    response_spec: Any,
    resolved_asks: list[Any],
) -> None:
    """Mutate response_spec and asks in-place with verifier corrections.

    Called by the orchestrator after verify() returns, before skill routing.
    """
    if not result.made_changes:
        return

    for adj in result.adjustments:
        if adj.field == "reply_mode":
            response_spec.reply_mode = adj.new_value
            # Cascade derived fields
            if adj.new_value == "full_synthesis":
                response_spec.memory_mode = "full"
                response_spec.followup_policy = "after_answer"
                response_spec.style_mode = "default"

        elif adj.field == "requires_current_data" and adj.ask_id:
            for a in resolved_asks:
                ask = getattr(a, "ask", a) if hasattr(a, "ask") else a
                if getattr(ask, "ask_id", "") == adj.ask_id:
                    ask.requires_current_data = adj.new_value

        elif adj.field == "capability_need" and adj.ask_id:
            for a in resolved_asks:
                ask = getattr(a, "ask", a) if hasattr(a, "ask") else a
                if getattr(ask, "ask_id", "") == adj.ask_id:
                    ask.capability_need = adj.new_value
