"""Regression tests for the knowledge-gap loop helpers in pipeline_phases.

Specifically guards against import drift between ``pipeline_phases`` and
``pipeline.antecedent``: the ``_contextualize_query`` helper lazily
imports symbols from the antecedent module, so a rename there would
only surface when the NEED_SEARCH loop actually fires — which is both
rare in tests and catastrophic in production (the whole turn crashes).
"""
from __future__ import annotations

from lokidoki.orchestrator.core.pipeline_phases import _contextualize_query


def test_contextualize_query_with_empty_context_returns_original():
    """No recent entity/topic → helper falls through to the raw_text
    fallback path without raising ImportError."""
    result = _contextualize_query(
        query="is it free",
        raw_text="is it free",
        safe_context={},
    )
    # Nothing to contextualize with an empty context; helper must
    # return gracefully (content is either original query or the
    # raw_text-prepend fallback, both acceptable).
    assert isinstance(result, str)
    assert "free" in result


def test_contextualize_query_substitutes_pronoun_with_recent_entity():
    """When session state has a recent person, 'is he free' → 'is <person> free'."""
    ctx = {
        "recent_entities": [
            {"name": "Stanley Kubrick", "type": "person"},
        ],
    }
    result = _contextualize_query(
        query="is he free",
        raw_text="is he free",
        safe_context=ctx,
    )
    assert "Stanley Kubrick" in result


def test_contextualize_query_does_not_raise_import_error():
    """Call with a realistic context to exercise the lazy import path.

    This is the specific regression: ``_contextualize_query`` imports
    from ``lokidoki.orchestrator.pipeline.antecedent`` at runtime.
    Previous versions imported ``_extract_recent_topic`` which no
    longer exists — causing every NEED_SEARCH turn to crash.
    """
    ctx = {
        "recent_entities": [{"name": "Red Letter Media", "type": "organization"}],
        "conversation_history": [
            {"role": "user", "content": "tell me about red letter media"},
            {"role": "assistant", "content": "They're a comedy film review group."},
        ],
    }
    # The exact return value is less important than "no exception".
    _contextualize_query("what causes youtube to terminate accounts", "what causes youtube to terminate accounts", ctx)
