from __future__ import annotations

import base64
import json
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.auth.dependencies import current_user
from lokidoki.auth.users import User
from lokidoki.main import app

_FAKE_USER = User(
    id=1,
    username="testuser",
    role="admin",
    status="active",
    last_password_auth_at=None,
)


async def _override_user() -> User:
    return _FAKE_USER


def _fake_stream(*_args, **_kwargs):
    yield {
        "audio_pcm": b"\x01\x00\x02\x00",
        "sample_rate": 22050,
        "phonemes": ["AA", "BB"],
        "samples_per_phoneme": 2,
        "text": "Hello world.",
    }


@pytest.mark.anyio
async def test_tts_stream_echoes_utterance_id_and_marks_final_chunk() -> None:
    app.dependency_overrides[current_user] = _override_user
    try:
        with (
            patch("lokidoki.api.routes.audio.voice_installed", return_value=True),
            patch("lokidoki.api.routes.audio.synthesize_stream", side_effect=_fake_stream),
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post(
                    "/api/v1/audio/tts/stream",
                    json={
                        "text": "Hello world.",
                        "voice": "en_US-lessac-medium",
                        "utterance_id": "utt-1",
                    },
                )
    finally:
        app.dependency_overrides.pop(current_user, None)

    assert response.status_code == 200
    lines = [json.loads(line) for line in response.text.strip().splitlines()]
    assert len(lines) >= 1
    assert all(line["utterance_id"] == "utt-1" for line in lines)
    assert lines[-1]["final"] is True
    pcm = base64.b64decode(lines[-1]["audio_base64"])
    assert pcm
