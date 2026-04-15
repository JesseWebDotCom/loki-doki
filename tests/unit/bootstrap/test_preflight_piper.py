"""Piper catalog + runtime guards.

Piper's real release tarball layout is uniform across platforms — a
single ``piper/`` top-level dir — so the binary-install path is covered
by the same extraction logic shared with uv/node. These tests focus on
the catalog (voice IDs are resolvable + well-formed) and on the dispatch
layer that picks the right per-profile voice.
"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest

from lokidoki.bootstrap.context import StepContext
from lokidoki.bootstrap.events import Event
from lokidoki.bootstrap.preflight.piper_runtime import ensure_tts_voice
from lokidoki.bootstrap.versions import PIPER_VOICES
from lokidoki.core.platform import PLATFORM_MODELS


_SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def test_every_profile_voice_is_pinned() -> None:
    """Each profile's ``tts_voice`` must exist in ``PIPER_VOICES``."""
    for profile, models in PLATFORM_MODELS.items():
        voice = models["tts_voice"]
        assert voice in PIPER_VOICES, (
            f"profile {profile!r} references voice {voice!r} which has no "
            "entry in PIPER_VOICES"
        )


def test_voice_entries_have_onnx_and_config_pairs() -> None:
    for voice_id, entries in PIPER_VOICES.items():
        assert "onnx" in entries and "config" in entries, (
            f"{voice_id}: missing onnx/config pair"
        )
        for name, (url, sha) in entries.items():
            assert url.startswith("https://"), f"{voice_id}.{name}: non-https url"
            assert _SHA_RE.match(sha), f"{voice_id}.{name}: bad sha256"


def test_unknown_voice_id_raises(tmp_path: Path) -> None:
    events: list[Event] = []
    ctx = StepContext(
        data_dir=tmp_path,
        profile="mac",
        arch="arm64",
        os_name="Darwin",
        emit=events.append,
    )
    with pytest.raises(RuntimeError, match="not pinned"):
        asyncio.run(ensure_tts_voice(ctx, "en_US-nonexistent-high"))
