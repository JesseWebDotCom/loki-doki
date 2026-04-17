"""Deterministic goal inference from pipeline state.

Derives ``likely_goal`` from constraints, features, routes, and text
without any additional model calls. Every signal comes from data the
pipeline already computed.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.orchestrator.core.types import ConstraintResult, RouteMatch

# Feasibility-signalling prefixes (checked against lowered text).
_FEASIBILITY_PREFIXES = (
    "can i",
    "will i",
    "is it possible",
    "could i",
    "am i able",
)

# Troubleshooting keywords in user text.
_TROUBLESHOOT_RE = re.compile(
    r"\b(?:not working|broken|fix|won't start|doesn't work|stopped working"
    r"|error|crash|failing|issue|problem)\b",
    re.IGNORECASE,
)

# Troubleshooting-related capabilities.
_TROUBLESHOOT_CAPABILITIES = frozenset({
    "troubleshoot",
    "diagnose",
    "fix",
    "debug",
})


def infer_goal(
    constraints: ConstraintResult,
    features: dict[str, Any],
    routes: list[RouteMatch],
    text: str,
) -> str:
    """Derive the user's likely goal from existing pipeline state.

    Returns a short label: ``comparison``, ``recommendation``,
    ``time_sensitive_decision``, ``feasibility``, ``troubleshooting``,
    or ``general``.
    """
    # 1. Constraint-driven (highest priority — structured signal).
    if constraints.is_comparison:
        return "comparison"
    if constraints.is_recommendation:
        return "recommendation"

    # 2. Time-sensitive decision: time constraint + an execution result.
    if constraints.time_constraint and features.get("has_execution_result"):
        return "time_sensitive_decision"

    lower = text.lower().lstrip()
    capabilities = {r.capability for r in routes}

    # 3. Feasibility: direct_chat + "can I" / "is it possible" phrasing.
    if "direct_chat" in capabilities:
        if any(lower.startswith(prefix) for prefix in _FEASIBILITY_PREFIXES):
            return "feasibility"

    # 4. Troubleshooting: keyword in text OR troubleshooting capability.
    if capabilities & _TROUBLESHOOT_CAPABILITIES:
        return "troubleshooting"
    if _TROUBLESHOOT_RE.search(text):
        return "troubleshooting"

    return "general"
