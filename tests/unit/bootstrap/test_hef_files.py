"""``ensure_hef_files`` — skip-if-present, fetch-if-missing.

We monkey-patch :class:`StepContext.download` rather than the underlying
``urlopen`` so the test stays small and engine-agnostic; the real
download path is exercised by ``test_download_integrity``.
"""
from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight import hef_files as hef_mod
from lokidoki.bootstrap.preflight.hef_files import (
    ensure_hef_files,
    hef_dir,
    required_hefs_for_profile,
)


def _ctx(tmp_path: Path, events: list[Event]) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="pi_hailo",
        arch="aarch64",
        os_name="Linux",
        emit=events.append,
    )


def _patch_hefs(monkeypatch: pytest.MonkeyPatch, payload: bytes) -> dict:
    """Pin the test HEFs to a synthetic payload + sha so download succeeds."""
    digest = hashlib.sha256(payload).hexdigest()
    table = {
        "yolov8m.hef": (
            "https://hailo.example/yolov8m.hef", digest, 50,
        ),
        "yolov5s_personface.hef": (
            "https://hailo.example/personface.hef", digest, 29,
        ),
        "Qwen2-VL-2B-Instruct.hef": (
            "https://hailo.example/qwen2vl.hef", digest, 420,
        ),
    }
    monkeypatch.setattr(hef_mod, "HEF_FILES", table)
    return table


def test_required_hefs_for_pi_hailo_lists_three_files() -> None:
    from lokidoki.core.platform import PLATFORM_MODELS

    required = required_hefs_for_profile(PLATFORM_MODELS["pi_hailo"])
    assert sorted(required) == sorted(
        ["yolov8m.hef", "yolov5s_personface.hef", "Qwen2-VL-2B-Instruct.hef"]
    )


def test_no_required_hefs_on_non_hailo_profile() -> None:
    from lokidoki.core.platform import PLATFORM_MODELS

    for profile in ("mac", "windows", "linux", "pi_cpu"):
        assert required_hefs_for_profile(PLATFORM_MODELS[profile]) == []


def test_ensure_hef_downloads_when_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b"\x89HEF" + b"0" * 64
    table = _patch_hefs(monkeypatch, payload)
    events: list[Event] = []
    ctx = _ctx(tmp_path, events)

    downloaded: list[tuple[str, Path]] = []

    async def fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        downloaded.append((url, dest))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)

    monkeypatch.setattr(StepContext, "download", fake_download)

    asyncio.run(ensure_hef_files(ctx, list(table.keys())))

    expected_dir = hef_dir(ctx)
    for name in table:
        assert (expected_dir / name).read_bytes() == payload
    assert {url for url, _ in downloaded} == {url for url, _, _ in table.values()}


def test_ensure_hef_skips_when_sha_matches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b"already on disk\n"
    table = _patch_hefs(monkeypatch, payload)
    events: list[Event] = []
    ctx = _ctx(tmp_path, events)

    target_dir = hef_dir(ctx)
    target_dir.mkdir(parents=True, exist_ok=True)
    for name in table:
        (target_dir / name).write_bytes(payload)

    download_calls: list[str] = []

    async def fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        download_calls.append(url)

    monkeypatch.setattr(StepContext, "download", fake_download)

    asyncio.run(ensure_hef_files(ctx, list(table.keys())))

    assert download_calls == [], "skip-if-present must avoid re-downloading"


def test_ensure_hef_re_downloads_when_sha_differs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fresh_payload = b"version-2 weights\n"
    table = _patch_hefs(monkeypatch, fresh_payload)
    events: list[Event] = []
    ctx = _ctx(tmp_path, events)

    target_dir = hef_dir(ctx)
    target_dir.mkdir(parents=True, exist_ok=True)
    name = next(iter(table))
    (target_dir / name).write_bytes(b"stale")  # different sha

    async def fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(fresh_payload)

    monkeypatch.setattr(StepContext, "download", fake_download)

    asyncio.run(ensure_hef_files(ctx, [name]))

    assert (target_dir / name).read_bytes() == fresh_payload


def test_unpinned_hef_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_hefs(monkeypatch, b"x")
    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    with pytest.raises(RuntimeError, match="not pinned"):
        asyncio.run(ensure_hef_files(ctx, ["totally_made_up.hef"]))
