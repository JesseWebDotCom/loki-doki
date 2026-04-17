"""Tests for deterministic goal inference from pipeline state."""
from __future__ import annotations

from lokidoki.orchestrator.core.types import ConstraintResult, RouteMatch
from lokidoki.orchestrator.pipeline.goal_inference import infer_goal


def _route(capability: str, idx: int = 0) -> RouteMatch:
    return RouteMatch(chunk_index=idx, capability=capability, confidence=0.9)


# --- comparison ---------------------------------------------------------------

def test_comparison_from_constraints():
    constraints = ConstraintResult(is_comparison=True)
    assert infer_goal(constraints, {}, [_route("direct_chat")], "") == "comparison"


# --- recommendation -----------------------------------------------------------

def test_recommendation_from_constraints():
    constraints = ConstraintResult(is_recommendation=True)
    assert infer_goal(constraints, {}, [_route("direct_chat")], "") == "recommendation"


# --- time_sensitive_decision --------------------------------------------------

def test_time_sensitive_with_execution():
    constraints = ConstraintResult(time_constraint="before 8pm")
    features = {"has_execution_result": True}
    assert infer_goal(constraints, features, [_route("get_time")], "") == "time_sensitive_decision"


def test_time_constraint_without_execution_is_general():
    """Time constraint alone (no execution result) → general, not time_sensitive."""
    constraints = ConstraintResult(time_constraint="by Friday")
    assert infer_goal(constraints, {}, [_route("direct_chat")], "") == "general"


# --- feasibility --------------------------------------------------------------

def test_feasibility_can_i():
    constraints = ConstraintResult()
    routes = [_route("direct_chat")]
    assert infer_goal(constraints, {}, routes, "can I walk there from Grand Central") == "feasibility"


def test_feasibility_is_it_possible():
    constraints = ConstraintResult()
    routes = [_route("direct_chat")]
    assert infer_goal(constraints, {}, routes, "is it possible to finish by Friday") == "feasibility"


def test_feasibility_requires_direct_chat():
    """Feasibility phrases only trigger when routed to direct_chat."""
    constraints = ConstraintResult()
    routes = [_route("get_weather")]
    assert infer_goal(constraints, {}, routes, "can I walk there") == "general"


# --- troubleshooting ----------------------------------------------------------

def test_troubleshooting_not_working():
    constraints = ConstraintResult()
    assert infer_goal(constraints, {}, [_route("direct_chat")], "my printer is not working") == "troubleshooting"


def test_troubleshooting_fix():
    constraints = ConstraintResult()
    assert infer_goal(constraints, {}, [_route("direct_chat")], "how do I fix this error") == "troubleshooting"


def test_troubleshooting_broken():
    constraints = ConstraintResult()
    assert infer_goal(constraints, {}, [_route("direct_chat")], "the screen is broken") == "troubleshooting"


# --- default ------------------------------------------------------------------

def test_default_general():
    constraints = ConstraintResult()
    assert infer_goal(constraints, {}, [_route("direct_chat")], "tell me about dogs") == "general"


# --- priority -----------------------------------------------------------------

def test_comparison_beats_recommendation():
    """When both flags are true, comparison wins (checked first)."""
    constraints = ConstraintResult(is_comparison=True, is_recommendation=True)
    assert infer_goal(constraints, {}, [_route("direct_chat")], "") == "comparison"
