"""Capability execution for the v2 prototype."""
from __future__ import annotations

import asyncio
from datetime import datetime

from v2.bmo_nlu.core.types import (
    ExecutionResult,
    ImplementationSelection,
    RequestChunk,
    ResolutionResult,
    RouteMatch,
)


def execute_chunk(
    chunk: RequestChunk,
    route: RouteMatch,
    implementation: ImplementationSelection,
    resolution: ResolutionResult,
) -> ExecutionResult:
    """Execute a routed chunk with simple deterministic handlers."""
    capability = route.capability

    if implementation.handler_name == "core.greetings.reply":
        output = "Hello."
    elif implementation.handler_name == "core.acknowledgments.reply":
        output = "You're welcome."
    elif implementation.handler_name == "core.dictionary.spell":
        output = resolution.resolved_target
    elif implementation.handler_name == "core.time.get_local_time":
        output = datetime.now().strftime("%-I:%M %p")
    else:
        output = chunk.text

    return ExecutionResult(chunk_index=chunk.index, capability=capability, output_text=output)


async def execute_chunk_async(
    chunk: RequestChunk,
    route: RouteMatch,
    implementation: ImplementationSelection,
    resolution: ResolutionResult,
) -> ExecutionResult:
    """Async wrapper for future parallel execution."""
    await asyncio.sleep(0)
    return execute_chunk(chunk, route, implementation, resolution)
