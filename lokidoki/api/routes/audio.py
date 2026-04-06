import os
import uuid
from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from lokidoki.core.audio import SpeechToText, TextToSpeech, AudioConfig

router = APIRouter()

_config = AudioConfig()
_stt = SpeechToText(model=_config.stt_model)
_tts = TextToSpeech(voice=_config.piper_voice)

AUDIO_DIR = "data/audio"
os.makedirs(AUDIO_DIR, exist_ok=True)


class TTSRequest(BaseModel):
    text: str
    voice: str = "en_US-lessac-medium"


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


@router.post("/tts")
async def text_to_speech(request: TTSRequest):
    """Synthesize text to speech using Piper TTS."""
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be empty")

    output_id = uuid.uuid4().hex
    output_path = os.path.join(AUDIO_DIR, f"tts_{output_id}.wav")

    tts = TextToSpeech(voice=request.voice) if request.voice != _config.piper_voice else _tts
    success = await tts.synthesize(request.text, output_path)

    if not success:
        raise HTTPException(status_code=500, detail="TTS synthesis failed")

    return FileResponse(output_path, media_type="audio/wav", filename=f"tts_{output_id}.wav")


@router.get("/config")
async def get_audio_config():
    """Return current audio configuration."""
    return {
        "piper_voice": _config.piper_voice,
        "stt_model": _config.stt_model,
        "read_aloud": _config.read_aloud,
    }


@router.get("/status")
async def audio_status():
    """Check availability of STT and TTS engines."""
    stt_available = await _stt.is_available()
    tts_available = await _tts.is_available()
    return {
        "stt": {"available": stt_available, "model": _config.stt_model},
        "tts": {"available": tts_available, "voice": _config.piper_voice},
    }
