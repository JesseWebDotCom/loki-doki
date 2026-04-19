"""Step definitions + profile-specific step ordering.

Each :class:`Step` has a stable ``id`` — later chunks replace the stub
``run()`` in place, so the IDs shipped here are load-bearing. Do not
rename them without updating every later chunk that binds real work
to the same IDs.

Chunks 3 + 4 now attach real runners to the python/uv/deps toolchain,
the embedded Node + frontend build, and the CPU-only audio stack. LLM
engines, vision, Hailo, and the rest still run the stub until their
chunks land.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from .context import StepContext
from .events import StepLog
from .preflight import (
    build_frontend,
    ensure_embedded_python,
    ensure_glyphs,
    ensure_graphhopper,
    ensure_node,
    ensure_planetiler,
    ensure_temurin_jre,
    ensure_tts_voice,
    ensure_uv,
    ensure_wake_word,
    ensure_whisper_model,
    install_frontend_deps,
    sync_python_deps,
)
from .preflight.hailo_ollama import ensure_hailo_ollama
from .preflight.hailo_runtime import ensure_hailo_runtime
from .preflight.hef_files import ensure_hef_files
from .preflight.llm_engine import (
    ensure_llm_engine,
    pull_llm_weights,
    warm_resident_llm,
)
from .preflight.archive_favicons import ensure_archive_favicons
from .preflight.vision import ensure_vision
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


def _profile_models(profile: str) -> dict:
    from lokidoki.core.platform import PLATFORM_MODELS  # local import avoids chunk-2 regressions

    if profile not in PLATFORM_MODELS:
        raise RuntimeError(f"unknown profile {profile!r}")
    return PLATFORM_MODELS[profile]


async def _install_piper_run(ctx: StepContext) -> None:
    voice = _profile_models(ctx.profile)["tts_voice"]
    await ensure_tts_voice(ctx, voice)


async def _install_whisper_run(ctx: StepContext) -> None:
    model_name = _profile_models(ctx.profile)["stt_model"]
    await ensure_whisper_model(ctx, model_name)


async def _install_wake_word_run(ctx: StepContext) -> None:
    engine = _profile_models(ctx.profile)["wake_word"]
    await ensure_wake_word(ctx, engine)


async def _pull_llm_fast_run(ctx: StepContext) -> None:
    await pull_llm_weights(ctx, "llm_fast", step_id="pull-llm-fast")


async def _pull_llm_thinking_run(ctx: StepContext) -> None:
    # On profiles where the fast + thinking slots reference the same
    # weights file (e.g. pi_hailo), ``pull_llm_weights`` short-circuits
    # on the on-disk file check so this step emits "already present".
    models = _profile_models(ctx.profile)
    if models["llm_thinking"] == models["llm_fast"]:
        ctx.emit(
            StepLog(
                step_id="pull-llm-thinking",
                line="thinking model equals fast model — already downloaded",
            )
        )
        return
    await pull_llm_weights(ctx, "llm_thinking", step_id="pull-llm-thinking")


_REAL_RUNNERS: dict[str, RunFn] = {
    "detect-profile": _detect_profile_run,
    "embed-python": ensure_embedded_python,
    "install-uv": ensure_uv,
    "install-jre": ensure_temurin_jre,
    "install-glyphs": ensure_glyphs,
    "install-planetiler": ensure_planetiler,
    "install-graphhopper": ensure_graphhopper,
    "sync-python-deps": sync_python_deps,
    "embed-node": ensure_node,
    "install-frontend-deps": install_frontend_deps,
    "build-frontend": build_frontend,
    "install-piper": _install_piper_run,
    "install-whisper": _install_whisper_run,
    "install-wake-word": _install_wake_word_run,
    "check-hailo-runtime": ensure_hailo_runtime,
    "install-hailo-ollama": ensure_hailo_ollama,
    "ensure-hef-files": ensure_hef_files,
    "install-llm-engine": ensure_llm_engine,
    "pull-llm-fast": _pull_llm_fast_run,
    "pull-llm-thinking": _pull_llm_thinking_run,
    "warm-resident-llm": warm_resident_llm,
    "install-vision": ensure_vision,
    "pull-vision-model": ensure_vision,
    "fetch-archive-icons": ensure_archive_favicons,
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
    category: str = "system"


# Step → category bucket. The wizard renders a 5-chip stepper above the
# progress ring; each chip represents one of these categories. Adding a
# new step requires assigning it a category here, otherwise it falls
# through to "system" and clutters the first chip.
_STEP_CATEGORY: dict[str, str] = {
    "detect-profile": "system",
    "embed-python": "system",
    "install-uv": "system",
    "install-jre": "system",
    "install-glyphs": "system",
    "install-planetiler": "system",
    "install-graphhopper": "system",
    "sync-python-deps": "system",
    "check-hailo-runtime": "system",
    "embed-node": "frontend",
    "install-frontend-deps": "frontend",
    "build-frontend": "frontend",
    "install-llm-engine": "ai",
    "install-hailo-ollama": "ai",
    "ensure-hef-files": "ai",
    "pull-llm-fast": "ai",
    "pull-llm-thinking": "ai",
    "warm-resident-llm": "ai",
    "install-vision": "ai",
    "pull-vision-model": "ai",
    "install-piper": "audio",
    "install-whisper": "audio",
    "install-wake-word": "audio",
    "install-detectors": "audio",
    "install-image-gen": "audio",
    "fetch-archive-icons": "finalize",
    "seed-database": "finalize",
    "spawn-app": "finalize",
}


# Step specs are flat (id, label, can_skip, est) tuples. Profile-specific
# rewrites (Hailo split, sub-steps swapped on pi_hailo) operate on these
# spec lists, then ``_to_steps`` materialises ``Step`` objects with the
# right runners attached.
_PRE_TOOLCHAIN: list[tuple[str, str, bool, int | None]] = [
    ("detect-profile", "Detect host profile", False, 2),
    ("embed-python", "Install embedded Python", False, 60),
    ("install-uv", "Install uv", False, 15),
    ("sync-python-deps", "Sync Python dependencies", False, 120),
]


_PRE_FRONTEND: list[tuple[str, str, bool, int | None]] = [
    ("embed-node", "Install embedded Node.js", False, 60),
    ("install-frontend-deps", "Install frontend dependencies", False, 120),
    ("build-frontend", "Build frontend bundle", False, 60),
]


# Maps stack — pinned JRE + Java JARs. Gated by
# :data:`_MAPS_ENABLED_PROFILES` so ``pi_hailo`` (and any future
# server-only profile) skips the download entirely. Runs after the
# frontend block so a maps failure doesn't block a mostly-working
# non-maps boot until after the UI bundle is ready.
_MAPS_ENABLED_PROFILES: frozenset[str] = frozenset(
    {"mac", "windows", "linux", "pi_cpu"}
)

_PRE_MAPS_STACK: list[tuple[str, str, bool, int | None]] = [
    ("install-jre", "Install Temurin JRE", False, 45),
    ("install-glyphs", "Install map glyph fonts", False, 15),
    ("install-planetiler", "Install planetiler", False, 30),
    ("install-graphhopper", "Install GraphHopper", False, 30),
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
    ("fetch-archive-icons", "Fetch archive icons", True, 15),
    ("spawn-app", "Launch LokiDoki app", False, 10),
]


_CHECK_HAILO: tuple[str, str, bool, int | None] = (
    "check-hailo-runtime", "Verify Hailo runtime", False, 5,
)
_INSTALL_HAILO_OLLAMA: tuple[str, str, bool, int | None] = (
    "install-hailo-ollama", "Install hailo-ollama", False, 120,
)
_ENSURE_HEF: tuple[str, str, bool, int | None] = (
    "ensure-hef-files", "Ensure HEF model files", False, 120,
)


# Tight-storage Pi setups can defer STT + wake-word — the app still
# boots without them, they just stay unwarmed until the user re-runs.
_PI_SKIPPABLE: frozenset[str] = frozenset({"install-whisper", "install-wake-word"})


def _to_steps(
    specs: list[tuple[str, str, bool, int | None]],
    profile: str,
) -> list[Step]:
    steps: list[Step] = []
    for sid, label, can_skip, est in specs:
        if profile in ("pi_cpu", "pi_hailo") and sid in _PI_SKIPPABLE:
            can_skip = True
        steps.append(
            Step(
                id=sid,
                label=label,
                can_skip=can_skip,
                est_seconds=est,
                run=_REAL_RUNNERS.get(sid, _stub_for(sid)),
                category=_STEP_CATEGORY.get(sid, "system"),
            )
        )
    return steps


def _hailo_specs() -> list[tuple[str, str, bool, int | None]]:
    """pi_hailo step ordering — see chunk-7-hailo.md.

    - ``check-hailo-runtime`` runs immediately after ``sync-python-deps``
      so a missing HAT can fall back to ``pi_cpu`` before we burn the
      ~3 minutes the frontend build takes.
    - ``install-hailo-ollama`` replaces ``install-llm-engine`` —
      hailo-ollama owns the engine slot on this profile.
    - ``ensure-hef-files`` lands before ``pull-vision-model`` (which
      becomes a no-op on hailo_ollama) since the HEFs *are* the vision
      weights for this profile.
    """
    llm = [s for s in _COMMON_LLM if s[0] != "install-llm-engine"]
    llm.insert(0, _INSTALL_HAILO_OLLAMA)

    media: list[tuple[str, str, bool, int | None]] = []
    for spec in _COMMON_MEDIA:
        if spec[0] == "pull-vision-model":
            media.append(_ENSURE_HEF)
        media.append(spec)

    return _PRE_TOOLCHAIN + [_CHECK_HAILO] + _PRE_FRONTEND + llm + media


def build_steps(profile: str) -> list[Step]:
    """Return the ordered step list for ``profile``.

    ``pi_hailo`` swaps in Hailo-specific runners and reorders the
    pre-toolchain block so the HAT is verified before slow steps run.
    Every other profile shares a single linear ordering. Profiles in
    :data:`_MAPS_ENABLED_PROFILES` insert the JRE + planetiler +
    GraphHopper block after the frontend steps and before the LLM/media
    downloads.
    """
    if profile == "pi_hailo":
        return _to_steps(_hailo_specs(), profile)
    specs = _PRE_TOOLCHAIN + _PRE_FRONTEND
    if profile in _MAPS_ENABLED_PROFILES:
        specs += _PRE_MAPS_STACK
    specs += _COMMON_LLM + _COMMON_MEDIA
    return _to_steps(specs, profile)


def build_maps_tools_only_steps(profile: str) -> list[Step]:
    """Return the standalone maps-runtime preflight path."""
    specs = [("detect-profile", "Detect host profile", False, 2), *_PRE_MAPS_STACK]
    return _to_steps(specs, profile)
