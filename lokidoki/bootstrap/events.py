"""Typed bootstrap pipeline events + JSON codec.

Every event subclass is a frozen dataclass — they are the only objects
that cross the threading/asyncio boundary between the pipeline thread
and the HTTP handlers. ``to_json`` / ``from_json`` are the lossless
wire format used by the SSE stream and by history replay.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Union


@dataclass(frozen=True)
class StepStart:
    step_id: str
    label: str
    can_skip: bool = False
    est_seconds: int | None = None


@dataclass(frozen=True)
class StepLog:
    step_id: str
    line: str
    stream: str = "stdout"


@dataclass(frozen=True)
class StepProgress:
    step_id: str
    pct: float
    bytes_done: int | None = None
    bytes_total: int | None = None


@dataclass(frozen=True)
class StepDone:
    step_id: str
    duration_s: float


@dataclass(frozen=True)
class StepFailed:
    step_id: str
    error: str
    remediation: str | None = None
    retryable: bool = True


@dataclass(frozen=True)
class PipelineComplete:
    app_url: str


@dataclass(frozen=True)
class PipelineHalted:
    reason: str


Event = Union[
    StepStart,
    StepLog,
    StepProgress,
    StepDone,
    StepFailed,
    PipelineComplete,
    PipelineHalted,
]


_TYPE_TO_CLASS: dict[str, type] = {
    "step_start": StepStart,
    "step_log": StepLog,
    "step_progress": StepProgress,
    "step_done": StepDone,
    "step_failed": StepFailed,
    "pipeline_complete": PipelineComplete,
    "pipeline_halted": PipelineHalted,
}

_CLASS_TO_TYPE: dict[type, str] = {cls: tag for tag, cls in _TYPE_TO_CLASS.items()}


def to_json(evt: Event) -> dict[str, Any]:
    """Serialise an event to a plain dict ready for ``json.dumps``."""
    tag = _CLASS_TO_TYPE.get(type(evt))
    if tag is None:
        raise TypeError(f"Unknown event type: {type(evt).__name__}")
    payload = dataclasses.asdict(evt)
    payload["type"] = tag
    return payload


def from_json(d: dict[str, Any]) -> Event:
    """Rehydrate an event from the dict produced by ``to_json``."""
    tag = d.get("type")
    cls = _TYPE_TO_CLASS.get(tag) if tag is not None else None
    if cls is None:
        raise ValueError(f"Unknown event tag: {tag!r}")
    fields = {f.name for f in dataclasses.fields(cls)}
    kwargs = {k: v for k, v in d.items() if k in fields}
    return cls(**kwargs)
