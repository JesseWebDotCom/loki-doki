"""``ensure_hailo_runtime`` raises ProfileFallback when no Hailo HAT is present.

Also asserts that ``Pipeline.run`` catches the fallback, rewrites its
step list with the new profile, persists the decision to
``bootstrap_config.json``, and re-runs from the top.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import (
    Event,
    PipelineComplete,
    PipelineHalted,
    StepFailed,
    StepStart,
)
from lokidoki.bootstrap.pipeline import Pipeline, ProfileFallback
from lokidoki.bootstrap.preflight import hailo_runtime as hailo_mod
from lokidoki.bootstrap.preflight.hailo_runtime import ensure_hailo_runtime
from lokidoki.bootstrap.steps import Step


def _ctx(tmp_path: Path, profile: str, emit) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile=profile,
        arch="aarch64",
        os_name="Linux",
        emit=emit,
    )


def test_ensure_hailo_runtime_falls_back_when_hardware_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        hailo_mod,
        "check_hailo_hardware",
        lambda: {
            "present": False,
            "device_node": False,
            "cli": False,
            "blacklist_ok": False,
            "missing": ["/dev/hailo0", "/usr/bin/hailortcli"],
        },
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, "pi_hailo", events.append)

    with pytest.raises(ProfileFallback) as excinfo:
        asyncio.run(ensure_hailo_runtime(ctx))

    assert excinfo.value.new_profile == "pi_cpu"
    failed = [e for e in events if isinstance(e, StepFailed)]
    assert failed and failed[0].step_id == "check-hailo-runtime"
    assert failed[0].retryable is False
    assert "pi_cpu" in (failed[0].remediation or "")


def test_ensure_hailo_runtime_blacklist_missing_emits_user_remediation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        hailo_mod,
        "check_hailo_hardware",
        lambda: {
            "present": True,
            "device_node": True,
            "cli": True,
            "blacklist_ok": False,
            "missing": [],
        },
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, "pi_hailo", events.append)

    # User-fixable cases halt without fallback — we use StepHalt for that.
    from lokidoki.bootstrap.pipeline import StepHalt

    with pytest.raises(StepHalt):
        asyncio.run(ensure_hailo_runtime(ctx))

    failed = [e for e in events if isinstance(e, StepFailed)]
    assert failed and failed[0].retryable is True
    assert "blacklist hailo_pci" in (failed[0].remediation or "")


def test_pipeline_restarts_with_new_profile_after_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drop the HAT, run the pipeline, expect a clean restart on pi_cpu."""
    monkeypatch.setattr(
        hailo_mod,
        "check_hailo_hardware",
        lambda: {
            "present": False,
            "device_node": False,
            "cli": False,
            "blacklist_ok": False,
            "missing": ["/dev/hailo0", "/usr/bin/hailortcli"],
        },
    )

    # Replace every real step with a no-op so the test doesn't try to
    # download Python tarballs etc. The fallback path is what we're
    # asserting, not the runners.
    from lokidoki.bootstrap import steps as steps_mod

    async def _noop(ctx: StepContext) -> None:
        return None

    real_runners = dict(steps_mod._REAL_RUNNERS)
    patched: dict[str, object] = {sid: _noop for sid in real_runners}
    # ``check-hailo-runtime`` keeps its real runner — that's what triggers
    # the fallback.
    patched["check-hailo-runtime"] = ensure_hailo_runtime
    monkeypatch.setattr(steps_mod, "_REAL_RUNNERS", patched)

    events: list[Event] = []
    pipeline = Pipeline(app_url="http://127.0.0.1:7860")
    ctx = _ctx(tmp_path, "pi_hailo", pipeline.emit)

    initial_steps = steps_mod.build_steps("pi_hailo")
    asyncio.run(pipeline.run(initial_steps, ctx))

    # 1. Profile switched in-place.
    assert ctx.profile == "pi_cpu"

    # 2. Fallback persisted to bootstrap_config.json.
    config = json.loads((tmp_path / "bootstrap_config.json").read_text())
    assert config["profile"] == "pi_cpu"
    assert config["profile_fallback_from"] == "pi_hailo"

    # 3. Step list was rewritten — pipeline restarted from ``detect-profile``
    #    a second time with the pi_cpu lineup (no Hailo steps).
    starts = [e.step_id for e in pipeline.history if isinstance(e, StepStart)]
    assert starts.count("detect-profile") == 2, starts
    assert "check-hailo-runtime" in starts  # ran once on the first attempt
    assert "install-hailo-ollama" not in starts  # never reached on pi_cpu

    # 4. Pipeline ended with PipelineComplete, not PipelineHalted.
    assert any(isinstance(e, PipelineComplete) for e in pipeline.history)
    assert not any(isinstance(e, PipelineHalted) for e in pipeline.history)


def test_check_hailo_hardware_returns_dict_shape(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Pure probe — must return the documented keys with no side effects."""
    # Point the probe at non-existent paths so the test passes on any host.
    monkeypatch.setattr(hailo_mod, "_DEVICE_NODE", tmp_path / "nope-hailo0")
    monkeypatch.setattr(hailo_mod, "_CLI_PATH", tmp_path / "nope-hailortcli")
    monkeypatch.setattr(hailo_mod, "_BLACKLIST_FILE", tmp_path / "nope-blacklist")

    result = hailo_mod.check_hailo_hardware()
    assert set(result.keys()) == {
        "present", "device_node", "cli", "blacklist_ok", "missing"
    }
    assert result["present"] is False
    assert result["device_node"] is False
    assert result["cli"] is False
    assert result["blacklist_ok"] is False
    assert isinstance(result["missing"], list) and result["missing"]
