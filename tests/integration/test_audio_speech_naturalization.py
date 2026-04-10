from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.auth.dependencies import current_user
from lokidoki.auth.users import User
from lokidoki.main import app

_FAKE_USER = User(id=1, username="testuser", role="admin", status="active", last_password_auth_at=None)


async def _override_user():
    return _FAKE_USER


class _FakeChunk:
    def __init__(self, pcm: bytes, sample_rate: int = 22050, phonemes: list[str] | None = None):
        self.audio_int16_bytes = pcm
        self.sample_rate = sample_rate
        self.phonemes = phonemes or ["AA"]


class _RecordingVoice:
    def __init__(self):
        self.calls: list[dict] = []

    def synthesize(self, text: str, **kwargs):
        self.calls.append({"text": text, **kwargs})
        yield _FakeChunk(b"\x01\x00\x02\x00", phonemes=["AA", "BB"])


@pytest.mark.anyio
async def test_tts_stream_uses_naturalized_segments_for_realistic_speech():
    voice = _RecordingVoice()
    app.dependency_overrides[current_user] = _override_user
    try:
        with (
            patch("lokidoki.api.routes.audio.voice_installed", return_value=True),
            patch("lokidoki.core.audio._cached_voice", return_value=voice),
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post(
                    "/api/v1/audio/tts/stream",
                    json={"text": "Dr. Kim is free on 04/09/2026 at 3:30 PM. Also, email user@example.com."},
                )
    finally:
        app.dependency_overrides.pop(current_user, None)

    assert response.status_code == 200
    events = [json.loads(line) for line in response.text.strip().splitlines()]
    assert len(events) >= 2
    assert voice.calls[0]["text"] == "Doctor Kim is free on April ninth, twenty twenty-six at three thirty PM."
    assert voice.calls[1]["text"] == "Also, email user at example dot com."


@pytest.mark.anyio
async def test_tts_stream_config_exposes_new_fields():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/api/v1/audio/config")

    assert response.status_code == 200
    data = response.json()
    assert data["speech_rate"] == 1.0
    assert data["sentence_pause"] == 0.4
    assert data["normalize_text"] is True


@pytest.mark.anyio
async def test_tts_stream_accepts_preview_overrides():
    voice = _RecordingVoice()
    app.dependency_overrides[current_user] = _override_user
    try:
        with (
            patch("lokidoki.api.routes.audio.voice_installed", return_value=True),
            patch("lokidoki.core.audio._cached_voice", return_value=voice),
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post(
                    "/api/v1/audio/tts/stream",
                    json={
                        "text": "Dr. Kim is free on 04/09/2026.",
                        "voice": "en_US-amy-medium",
                        "speech_rate": 1.2,
                        "sentence_pause": 0.7,
                        "normalize_text": False,
                    },
                )
    finally:
        app.dependency_overrides.pop(current_user, None)

    assert response.status_code == 200
    assert voice.calls[0]["text"] == "Dr. Kim is free on 04/09/2026."
    assert voice.calls[0]["length_scale"] == 1.15
