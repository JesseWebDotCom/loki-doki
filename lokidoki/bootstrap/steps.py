"""Step definitions + profile-specific step ordering.

Each :class:`Step` has a stable ``id`` — later chunks replace the stub
``run()`` in place, so the IDs shipped here are load-bearing. Do not
rename them without updating every later chunk that binds real work
to the same IDs.

Chunk 3 attaches real implementations to ``embed-python``, ``install-uv``,
``sync-python-deps``, and ``spawn-app``. The rest remain stubs until
their chunks land.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from .context import StepContext
from .events import StepLog
from .preflight import ensure_embedded_python, ensure_uv, sync_python_deps
from .run_app import spawn_fastapi_app


RunFn = Callable[[StepContext], Awaitable[None]]


async def _stub_run(step_id: str, ctx: StepContext) -> None:
    """Placeholder for steps whose owning chunk hasn't landed yet."""
    ctx.emit(StepLog(step_id=step_id, line=f"[stub] {step_id} starting"))
    await asyncio.sleep(0.05)
    ctx.emit(StepLog(step_id=step_id, line=f"[stub] {step_id} done"))


def _stub_for(step_id: str) -> RunFn:
    async def _run(ctx: StepContext) -> None:
        await _stub_run(step_id, ctx)
    return _run


async def _detect_profile_run(ctx: StepContext) -> None:
    ctx.emit(
        StepLog(
            step_id="detect-profile",
            line=f"profile={ctx.profile} os={ctx.os_name} arch={ctx.arch}",
        )
    )


_REAL_RUNNERS: dict[str, RunFn] = {
    "detect-profile": _detect_profile_run,
    "embed-python": ensure_embedded_python,
    "install-uv": ensure_uv,
    "sync-python-deps": sync_python_deps,
    "spawn-app": spawn_fastapi_app,
}


@dataclass(frozen=True)
class Step:
    """One pipeline step. ``run`` gets a :class:`StepContext` and awaits."""

    id: str
    label: str
    can_skip: bool = False
    est_seconds: int | None = None
    depends_on: tuple[str, ...] = ()
    run: RunFn = field(default=None)  # type: ignore[assignment]


_COMMON_PRE: list[tuple[str, str, bool, int | None]] = [
    ("detect-profile", "Detect host profile", False, 2),
    ("embed-python", "Install embedded Python", False, 60),
    ("install-uv", "Install uv", False, 15),
    ("sync-python-deps", "Sync Python dependencies", False, 120),
    ("embed-node", "Install embedded Node.js", False, 60),
    ("install-frontend-deps", "Install frontend dependencies", False, 120),
    ("build-frontend", "Build frontend bundle", False, 60),
]


_COMMON_LLM: list[tuple[str, str, bool, int | None]] = [
    ("install-llm-engine", "Install LLM engine", False, 60),
    ("pull-llm-fast", "Download fast LLM", False, 180),
    ("pull-llm-thinking", "Download thinking LLM", False, 240),
    ("warm-resident-llm", "Warm resident LLM", False, 30),
]


_COMMON_MEDIA: list[tuple[str, str, bool, int | None]] = [
    ("install-vision", "Install vision engine", False, 60),
    ("pull-vision-model", "Download vision model", False, 180),
    ("install-piper", "Install Piper TTS", False, 30),
    ("install-whisper", "Install Whisper STT", False, 30),
    ("install-wake-word", "Install wake-word engine", False, 30),
    ("install-detectors", "Install object and face detectors", False, 30),
    ("install-image-gen", "Install image generator", True, 120),
    ("seed-database", "Seed SQLite database", False, 5),
    ("spawn-app", "Launch LokiDoki app", False, 10),
]


_HAILO_PRE: list[tuple[str, str, bool, int | None]] = [
    ("check-hailo-runtime", "Verify Hailo runtime", False, 5),
    ("install-hailo-ollama", "Install hailo-ollama", False, 120),
    ("ensure-hef-files", "Ensure HEF model files", False, 120),
]


def _to_steps(
    specs: list[tuple[str, str, bool, int | None]],
) -> list[Step]:
    return [
        Step(
            id=sid,
            label=label,
            can_skip=can_skip,
            est_seconds=est,
            run=_REAL_RUNNERS.get(sid, _stub_for(sid)),
        )
        for sid, label, can_skip, est in specs
    ]


def build_steps(profile: str) -> list[Step]:
    """Return the ordered step list for ``profile``.

    ``pi_hailo`` inserts the Hailo runtime checks immediately before the
    shared LLM-engine block. Every other profile shares a single linear
    ordering.
    """
    pre = _to_steps(_COMMON_PRE)
    llm = _to_steps(_COMMON_LLM)
    media = _to_steps(_COMMON_MEDIA)

    if profile == "pi_hailo":
        return pre + _to_steps(_HAILO_PRE) + llm + media
    return pre + llm + media
