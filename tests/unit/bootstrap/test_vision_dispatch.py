"""``ensure_vision`` must pick the right per-engine installer.

We stub out the mlx / llama.cpp / hailo paths and assert the dispatcher
delegates based on ``PLATFORM_MODELS[profile]["llm_engine"]`` — there
is no profile that ships without vision plumbing, but pi_hailo's HEF
path is owned by chunk 7 so we assert we leave a breadcrumb rather
than crashing.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Callable

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event, StepLog
from lokidoki.bootstrap.preflight import vision as vision_dispatch
from lokidoki.bootstrap.versions import VISION_MMPROJ


def _ctx(tmp_path: Path, events: list[Event], profile: str) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile=profile,
        arch="arm64" if profile in {"mac", "pi_cpu", "pi_hailo"} else "x86_64",
        os_name={"mac": "Darwin", "windows": "Windows"}.get(profile, "Linux"),
        emit=events.append,
    )


def _install_stub(
    monkeypatch: pytest.MonkeyPatch, name: str, recorder: list[tuple[str, str]]
) -> None:
    async def fake(ctx: StepContext, model_id: str) -> None:
        recorder.append((name, model_id))

    monkeypatch.setattr(f"lokidoki.bootstrap.preflight.vision.{name}", fake)


@pytest.mark.parametrize(
    "profile,expected_fn",
    [
        ("mac", "ensure_vision_mlx"),
        ("windows", "ensure_vision_llama_cpp"),
        ("linux", "ensure_vision_llama_cpp"),
        ("pi_cpu", "ensure_vision_llama_cpp"),
    ],
)
def test_dispatcher_picks_engine_installer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profile: str, expected_fn: str
) -> None:
    calls: list[tuple[str, str]] = []
    _install_stub(monkeypatch, "ensure_vision_mlx", calls)
    _install_stub(monkeypatch, "ensure_vision_llama_cpp", calls)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events, profile)
    asyncio.run(vision_dispatch.ensure_vision(ctx))

    assert len(calls) == 1, f"expected exactly one installer call, got {calls!r}"
    actual_fn, model_id = calls[0]
    assert actual_fn == expected_fn

    from lokidoki.core.platform import PLATFORM_MODELS

    assert model_id == PLATFORM_MODELS[profile]["vision_model"]


def test_pi_hailo_leaves_breadcrumb(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, str]] = []
    _install_stub(monkeypatch, "ensure_vision_mlx", calls)
    _install_stub(monkeypatch, "ensure_vision_llama_cpp", calls)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events, "pi_hailo")
    asyncio.run(vision_dispatch.ensure_vision(ctx))

    assert calls == [], "pi_hailo must not invoke mlx or llama.cpp installers"
    deferred = [
        ev for ev in events
        if isinstance(ev, StepLog) and "deferred" in ev.line
    ]
    assert deferred, "pi_hailo should log a deferral breadcrumb"


def test_vision_mmproj_matches_llama_cpp_profiles() -> None:
    """Every llama.cpp profile's vision_model must have a VISION_MMPROJ entry."""
    from lokidoki.core.platform import PLATFORM_MODELS

    for profile, cfg in PLATFORM_MODELS.items():
        if cfg["llm_engine"] not in {"llama_cpp_vulkan", "llama_cpp_cpu"}:
            continue
        model_ref = cfg["vision_model"]
        assert model_ref in VISION_MMPROJ, (
            f"profile {profile!r} vision_model {model_ref!r} "
            "missing from VISION_MMPROJ in bootstrap/versions.py"
        )
        entry = VISION_MMPROJ[model_ref]
        assert entry["weights_filename"].endswith(".gguf")
        assert entry["mmproj_filename"].startswith("mmproj-")
        assert entry["mmproj_filename"].endswith(".gguf")


def test_vision_llama_cpp_resolves_paths(tmp_path: Path) -> None:
    """``resolve_vision_gguf`` splits a catalog entry into on-disk neighbours."""
    from lokidoki.bootstrap.preflight.vision_llama_cpp import resolve_vision_gguf

    events: list[Event] = []
    ctx = _ctx(tmp_path, events, "linux")
    ref = resolve_vision_gguf(ctx, "Qwen/Qwen2-VL-7B-Instruct-GGUF:Q4_K_M")
    assert ref.repo_id == "Qwen/Qwen2-VL-7B-Instruct-GGUF"
    assert ref.weights.name == "Qwen2-VL-7B-Instruct-Q4_K_M.gguf"
    assert ref.mmproj.name == "mmproj-Qwen2-VL-7B-Instruct-f16.gguf"
    # both files resolve into the same directory so llama-server's
    # --mmproj flag can find the projector next to --model
    assert ref.weights.parent == ref.mmproj.parent
    assert ref.weights.parent == tmp_path / "models" / "vision" / ref.repo_id


# quiet unused typing imports
_ = Callable
