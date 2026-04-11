"""Response combination for the v2 prototype."""
from __future__ import annotations

from v2.bmo_nlu.core.types import ExecutionResult, ResponseObject


def combine_outputs(executions: list[ExecutionResult]) -> ResponseObject:
    """Join execution outputs into one user-facing response."""
    combined = " ".join(result.output_text.strip() for result in executions if result.output_text.strip())
    return ResponseObject(output_text=combined)
