"""Audio API routes — streaming Piper TTS + Whisper STT.

`/tts/stream` returns an ndjson stream where each line is a JSON object
containing base64-encoded little-endian int16 PCM, the sample rate, the
phoneme list for that chunk, and a heuristic `samples_per_phoneme` so
the browser can schedule visemes against the audio timeline.

There is intentionally no WAV-on-disk path. Speech must reach the user
as soon as Piper produces the first sentence.
"""
from __future__ import annotations

import base64
import json
import os
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from lokidoki.core.audio import (
    AudioConfig,
    SpeechToText,
    synthesize_stream,
    voice_installed,
    warm_voice,
)

router = APIRouter()

_config = AudioConfig()
_stt = SpeechToText(model=_config.stt_model)

AUDIO_DIR = "data/audio"
os.makedirs(AUDIO_DIR, exist_ok=True)


class TTSRequest(BaseModel):
    text: str
    voice: str | None = None


@router.post("/stt")
async def speech_to_text(file: UploadFile = File(...)):
    """Transcribe uploaded audio to text using Faster-Whisper."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file uploaded")

    audio_path = os.path.join(AUDIO_DIR, f"stt_{uuid.uuid4().hex}.wav")
    try:
        content = await file.read()
        with open(audio_path, "wb") as f:
            f.write(content)
        text = await _stt.transcribe(audio_path)
        return {"text": text, "model": _config.stt_model}
    finally:
        if os.path.exists(audio_path):
            os.remove(audio_path)


@router.post("/tts/stream")
async def text_to_speech_stream(request: TTSRequest):
    """Stream Piper output as ndjson chunks (no WAV-on-disk)."""
    text = (request.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text must not be empty")

    voice_id = (request.voice or _config.piper_voice).strip()
    if not voice_installed(voice_id):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Piper voice '{voice_id}' is not installed under "
                f"data/models/piper. Drop the .onnx and .onnx.json there."
            ),
        )

    def iter_chunks():
        try:
            for chunk in synthesize_stream(text, voice_id):
                yield json.dumps({
                    "audio_base64": base64.b64encode(chunk["audio_pcm"]).decode("ascii"),
                    "sample_rate": chunk["sample_rate"],
                    "phonemes": chunk["phonemes"],
                    "samples_per_phoneme": chunk["samples_per_phoneme"],
                }) + "\n"
        except Exception as exc:
            yield json.dumps({"error": str(exc)}) + "\n"

    return StreamingResponse(iter_chunks(), media_type="application/x-ndjson")


@router.post("/tts/warm")
async def warm_tts_voice():
    """Preload the active Piper voice into process memory."""
    ok = warm_voice(_config.piper_voice)
    return {"ok": ok, "voice": _config.piper_voice}


@router.get("/config")
async def get_audio_config():
    return {
        "piper_voice": _config.piper_voice,
        "stt_model": _config.stt_model,
        "read_aloud": _config.read_aloud,
    }


@router.get("/status")
async def audio_status():
    stt_available = await _stt.is_available()
    tts_available = voice_installed(_config.piper_voice)
    return {
        "stt": {"available": stt_available, "model": _config.stt_model},
        "tts": {"available": tts_available, "voice": _config.piper_voice},
    }
