"""Capability execution for the v2 prototype."""
from __future__ import annotations

from datetime import datetime

from v2.bmo_nlu.core.types import ExecutionResult, RequestChunk, ResolutionResult, RouteMatch


def execute_chunk(chunk: RequestChunk, route: RouteMatch, resolution: ResolutionResult) -> ExecutionResult:
    """Execute a routed chunk with simple deterministic handlers."""
    capability = route.capability
    lower = chunk.text.lower().strip()

    if capability == "greeting_response":
        output = "Hello."
    elif capability == "acknowledgment_response":
        output = "You're welcome."
    elif capability == "spell_word":
        output = resolution.resolved_target
    elif capability == "get_current_time":
        output = datetime.now().strftime("%-I:%M %p")
    else:
        output = chunk.text

    return ExecutionResult(chunk_index=chunk.index, capability=capability, output_text=output)
