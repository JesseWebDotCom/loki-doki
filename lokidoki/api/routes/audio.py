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

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from lokidoki.core.audio import (
    AudioConfig,
    SpeechToText,
    synthesize_stream,
    voice_installed,
    warm_voice,
)
from lokidoki.core.person_pronunciation import collect_person_pronunciation_fixes
from lokidoki.core.pronunciation_fixes import (
    delete_admin_fix,
    get_merged_fixes,
    list_all_fixes,
    set_admin_fix,
)
from lokidoki.api.routes.settings import _load_settings
from lokidoki.auth.dependencies import current_user, get_memory, require_admin
from lokidoki.auth.users import User
from lokidoki.core.memory_provider import MemoryProvider

router = APIRouter()

_config = AudioConfig()
_stt = SpeechToText(model=_config.stt_model)

AUDIO_DIR = "data/audio"
os.makedirs(AUDIO_DIR, exist_ok=True)


class TTSRequest(BaseModel):
    text: str
    voice: str | None = None
    speech_rate: float | None = None
    sentence_pause: float | None = None
    normalize_text: bool | None = None


def _current_audio_config() -> AudioConfig:
    loaded = _load_settings()
    return AudioConfig(
        piper_voice=str(loaded.get("piper_voice", _config.piper_voice)),
        stt_model=str(loaded.get("stt_model", _config.stt_model)),
        read_aloud=bool(loaded.get("read_aloud", _config.read_aloud)),
        speech_rate=float(loaded.get("speech_rate", _config.speech_rate)),
        sentence_pause=float(loaded.get("sentence_pause", _config.sentence_pause)),
        normalize_text=bool(loaded.get("normalize_text", _config.normalize_text)),
    )


def _merge_preview_overrides(
    config: AudioConfig,
    request: TTSRequest,
) -> AudioConfig:
    return AudioConfig(
        piper_voice=config.piper_voice,
        stt_model=config.stt_model,
        read_aloud=config.read_aloud,
        speech_rate=(
            float(request.speech_rate)
            if request.speech_rate is not None
            else config.speech_rate
        ),
        sentence_pause=(
            float(request.sentence_pause)
            if request.sentence_pause is not None
            else config.sentence_pause
        ),
        normalize_text=(
            bool(request.normalize_text)
            if request.normalize_text is not None
            else config.normalize_text
        ),
    )


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
async def text_to_speech_stream(
    request: TTSRequest,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """Stream Piper output as ndjson chunks (no WAV-on-disk)."""
    text = (request.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text must not be empty")

    config = _merge_preview_overrides(_current_audio_config(), request)
    voice_id = (request.voice or config.piper_voice).strip()
    if not voice_installed(voice_id):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Piper voice '{voice_id}' is not installed under "
                f"data/models/piper. Drop the .onnx and .onnx.json there."
            ),
        )

    def _load_fixes(conn):
        fixes = get_merged_fixes(conn)
        # Person-level pronunciations layer on top (person wins over global)
        fixes.update(collect_person_pronunciation_fixes(conn, user.id))
        return fixes

    fixes = await memory.run_sync(_load_fixes)

    def iter_chunks():
        try:
            for chunk in synthesize_stream(text, voice_id, config=config, pronunciation_fixes=fixes):
                yield json.dumps({
                    "audio_base64": base64.b64encode(chunk["audio_pcm"]).decode("ascii"),
                    "sample_rate": chunk["sample_rate"],
                    "phonemes": chunk["phonemes"],
                    "samples_per_phoneme": chunk["samples_per_phoneme"],
                    "text": chunk.get("text", ""),
                }) + "\n"
        except Exception as exc:
            yield json.dumps({"error": str(exc)}) + "\n"

    return StreamingResponse(iter_chunks(), media_type="application/x-ndjson")


@router.post("/tts/warm")
async def warm_tts_voice():
    """Preload the active Piper voice into process memory."""
    config = _current_audio_config()
    ok = warm_voice(config.piper_voice)
    return {"ok": ok, "voice": config.piper_voice}


@router.get("/config")
async def get_audio_config():
    config = _current_audio_config()
    return {
        "piper_voice": config.piper_voice,
        "stt_model": config.stt_model,
        "read_aloud": config.read_aloud,
        "speech_rate": config.speech_rate,
        "sentence_pause": config.sentence_pause,
        "normalize_text": config.normalize_text,
    }


@router.get("/status")
async def audio_status():
    config = _current_audio_config()
    stt_available = await _stt.is_available()
    tts_available = voice_installed(config.piper_voice)
    return {
        "stt": {"available": stt_available, "model": _config.stt_model},
        "tts": {"available": tts_available, "voice": config.piper_voice},
    }


# ---- Pronunciation fixes (admin-managed) ---------------------------------


class PronunciationFixBody(BaseModel):
    word: str
    spoken: str


@router.get("/pronunciation")
async def list_pronunciation_fixes(
    memory: MemoryProvider = Depends(get_memory),
):
    """Return all pronunciation fixes (builtin + admin) with source metadata."""
    fixes = await memory.run_sync(list_all_fixes)
    return {"fixes": fixes}


@router.put("/pronunciation")
async def upsert_pronunciation_fix(
    body: PronunciationFixBody,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Create or update an admin pronunciation fix."""
    word = body.word.strip()
    spoken = body.spoken.strip()
    if not word or not spoken:
        raise HTTPException(status_code=400, detail="word and spoken must not be empty")
    await memory.run_sync(lambda c: set_admin_fix(c, word, spoken))
    return {"status": "saved", "word": word.lower(), "spoken": spoken}


@router.delete("/pronunciation/{word}")
async def remove_pronunciation_fix(
    word: str,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Delete an admin pronunciation fix. Built-in fixes cannot be deleted."""
    deleted = await memory.run_sync(lambda c: delete_admin_fix(c, word))
    if not deleted:
        raise HTTPException(status_code=404, detail="fix not found or is built-in")
    return {"status": "deleted", "word": word.lower()}
