"""Stdlib ANSI trace console renderer for the orchestrator.

The spec called for "rich terminal output (dev mode)" — but the project
does not depend on the ``rich`` library, and adding a dependency just for
this would be wasteful. This renderer uses ANSI escape codes from the
stdlib only and plugs into the existing :class:`TraceData.subscribe`
listener seam introduced in Phase 6.

Usage::

    from lokidoki.orchestrator.observability.console import attach_console_renderer
    from lokidoki.orchestrator.observability.tracing import start_trace

    trace = start_trace()
    attach_console_renderer(trace)
    # ... run pipeline ...

The renderer is process-local. It does not write to logs (use
``logging`` for that) and does not buffer — each step is flushed as
soon as it lands so a long-running pipeline shows live progress.
"""
from __future__ import annotations

import os
import sys
from typing import IO, Callable

from lokidoki.orchestrator.core.types import TraceData, TraceStep

# ANSI escape codes. Kept narrow on purpose — no external dependency.
_RESET = "\x1b[0m"
_DIM = "\x1b[2m"
_BOLD = "\x1b[1m"
_CYAN = "\x1b[36m"
_GREEN = "\x1b[32m"
_YELLOW = "\x1b[33m"
_RED = "\x1b[31m"
_GREY = "\x1b[90m"
_MAGENTA = "\x1b[35m"

_STATUS_COLOR: dict[str, str] = {
    "done": _GREEN,
    "matched": _CYAN,
    "bypassed": _YELLOW,
    "error": _RED,
    "warn": _YELLOW,
}

_STEP_COLOR: dict[str, str] = {
    "normalize": _GREY,
    "signals": _GREY,
    "fast_lane": _CYAN,
    "parse": _GREY,
    "split": _GREY,
    "extract": _GREY,
    "route": _MAGENTA,
    "select_implementation": _MAGENTA,
    "resolve": _MAGENTA,
    "execute": _GREEN,
    "request_spec": _GREY,
    "combine": _BOLD,
}


def _supports_color(stream: IO[str]) -> bool:
    """Return True when the stream is attached to a colour-capable terminal."""
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("FORCE_COLOR"):
        return True
    isatty = getattr(stream, "isatty", None)
    return bool(isatty and isatty())


def render_step(step: TraceStep, *, use_color: bool = True) -> str:
    """Format a single :class:`TraceStep` as one line of terminal output."""
    name = step.name.ljust(22)
    timing = f"{step.timing_ms:>7.2f}ms"
    status = step.status.ljust(9)
    summary = _summarise_details(step)

    if use_color:
        name_color = _STEP_COLOR.get(step.name, _GREY)
        status_color = _STATUS_COLOR.get(step.status, _GREY)
        return (
            f"{_DIM}│{_RESET} "
            f"{name_color}{name}{_RESET} "
            f"{status_color}{status}{_RESET} "
            f"{_DIM}{timing}{_RESET}"
            f"{(' ' + summary) if summary else ''}"
        )
    return f"| {name} {status} {timing}{(' ' + summary) if summary else ''}"


def _summarise_details(step: TraceStep) -> str:
    """Return a one-line key=value summary of the most useful details."""
    details = step.details or {}
    if not details:
        return ""
    interesting: list[str] = []
    for key in (
        "cleaned_text",
        "capability",
        "matched",
        "reason",
        "count",
        "chunk_count",
        "mode",
        "output_text",
        "trace_id",
        "parser",
    ):
        if key in details and details[key] not in (None, "", [], {}):
            value = details[key]
            if isinstance(value, str) and len(value) > 40:
                value = value[:37] + "…"
            interesting.append(f"{key}={value}")
    return " ".join(interesting)


def attach_console_renderer(
    trace: TraceData,
    *,
    stream: IO[str] | None = None,
    use_color: bool | None = None,
) -> Callable[[TraceStep], None]:
    """Subscribe a console renderer to ``trace`` and return the listener.

    The returned callable is the listener registered with
    :meth:`TraceData.subscribe` so callers can detach it later by
    removing it from ``trace.listeners`` if they want to. In normal
    usage you can ignore the return value.
    """
    target = stream if stream is not None else sys.stderr
    coloured = use_color if use_color is not None else _supports_color(target)

    def listener(step: TraceStep) -> None:
        line = render_step(step, use_color=coloured)
        try:
            target.write(line + "\n")
            flush = getattr(target, "flush", None)
            if flush is not None:
                flush()
        except Exception:  # noqa: BLE001 - never break the trace because of stderr
            return

    trace.subscribe(listener)
    return listener
