"""STT dispatch — whisper.cpp downloads, faster-whisper warms via subprocess.

The chunk 4 contract: the step dispatches on the ``stt_model`` string.
``whisper.cpp base.en`` resolves to a pinned GGML download; a
``faster-whisper …`` id never touches ``download`` (the weights come
down lazily inside a warm-up subprocess the wizard spawns).
"""
from __future__ import annotations

import asyncio
import hashlib
import io
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight import whisper_runtime
from lokidoki.bootstrap.preflight.whisper_runtime import ensure_whisper_model
from lokidoki.bootstrap.versions import WHISPER


class _FakeResponse:
    def __init__(self, data: bytes) -> None:
        self._stream = io.BytesIO(data)
        self.headers = {"Content-Length": str(len(data))}
        self.url = "https://example.invalid/ggml-base.en.bin"
        self.status = 200

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc) -> None:
        self._stream.close()

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)


def _ctx(tmp_path: Path, events: list[Event]) -> StepContext:
    return StepContext(
        data_dir=tmp_path,
        profile="pi_cpu",
        arch="aarch64",
        os_name="Linux",
        emit=events.append,
    )


def test_whisper_cpp_downloads_pinned_weight(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b"fake-ggml-weights"
    digest = hashlib.sha256(payload).hexdigest()

    patched = dict(WHISPER)
    original = patched["whisper.cpp base.en"]
    patched["whisper.cpp base.en"] = (original[0], digest)
    monkeypatch.setattr(whisper_runtime, "WHISPER", patched)

    def _fake_urlopen(req, *args, **kwargs):  # noqa: ANN001
        return _FakeResponse(payload)

    monkeypatch.setattr(
        "lokidoki.bootstrap.context.urllib.request.urlopen", _fake_urlopen
    )

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_whisper_model(ctx, "whisper.cpp base.en"))

    dest = tmp_path / "whisper" / "ggml-base.en.bin"
    assert dest.exists()
    assert dest.read_bytes() == payload


def test_faster_whisper_skips_download_and_invokes_subprocess(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``faster-whisper small.en`` must not call ``download``."""
    # make binary_path("python") point at something that exists so the
    # guard doesn't trip before we reach the warm-up subprocess
    (tmp_path / "python" / "bin").mkdir(parents=True)
    fake_python = tmp_path / "python" / "bin" / "python"
    fake_python.write_text("")
    fake_python.chmod(0o755)

    download_calls: list[tuple] = []

    async def _fake_download(self, url, dest, step_id, sha256=None):  # noqa: ANN001
        download_calls.append((url, dest, step_id, sha256))

    monkeypatch.setattr(StepContext, "download", _fake_download)

    run_streamed_calls: list[list[str]] = []

    async def _fake_run_streamed(self, cmd, step_id, cwd=None, env=None):  # noqa: ANN001
        run_streamed_calls.append(list(cmd))
        return 0

    monkeypatch.setattr(StepContext, "run_streamed", _fake_run_streamed)

    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    asyncio.run(ensure_whisper_model(ctx, "faster-whisper small.en"))

    assert download_calls == [], "faster-whisper should not hit download"
    assert run_streamed_calls, "faster-whisper warm-up subprocess not invoked"
    # the subprocess script should reference WhisperModel + the size tag
    joined = " ".join(run_streamed_calls[0])
    assert "WhisperModel" in joined
    assert "'small.en'" in joined


def test_unknown_stt_backend_raises(tmp_path: Path) -> None:
    events: list[Event] = []
    ctx = _ctx(tmp_path, events)
    with pytest.raises(RuntimeError, match="unsupported whisper model"):
        asyncio.run(ensure_whisper_model(ctx, "coqui-ai fancy.en"))


# quiet unused-import warnings
_ = AsyncMock
