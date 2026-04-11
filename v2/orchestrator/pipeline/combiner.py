"""Deterministic combiner for the v2 prototype."""
from __future__ import annotations

from v2.orchestrator.core.types import RequestSpec, ResponseObject


def combine_request_spec(spec: RequestSpec) -> ResponseObject:
    """Join the per-chunk outputs of a RequestSpec into a single response."""
    parts: list[str] = []
    for chunk in spec.chunks:
        if chunk.role != "primary_request":
            continue
        if chunk.capability == "direct_chat":
            # The direct_chat handler is an echo, so its output_text is
            # whatever the user said. Never deliver that as the answer.
            # ``decide_llm`` is supposed to route direct_chat to LLM
            # before we get here; this branch is a defensive guard for
            # the case where LLM is unavailable and the synthesizer
            # fell back to the deterministic combiner.
            parts.append(
                "I don't have a built-in answer for that — try enabling LLM "
                "or rephrasing as a question I can route to a skill."
            )
            continue
        text = str(chunk.result.get("output_text") or "").strip()
        if text:
            parts.append(text)
            continue
        if not chunk.success and chunk.error:
            parts.append(f"I couldn't complete that ({chunk.capability}).")
    return ResponseObject(output_text=" ".join(parts).strip())


# Backwards-compatible alias for callers that pass an executions list.
def combine_outputs(executions) -> ResponseObject:  # type: ignore[no-untyped-def]
    parts = [
        result.output_text.strip()
        for result in executions
        if getattr(result, "output_text", "") and result.output_text.strip()
    ]
    return ResponseObject(output_text=" ".join(parts))
