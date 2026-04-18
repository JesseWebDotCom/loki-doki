"""Voice management API routes — upload, list, test, and delete Piper voices.

Admin-only endpoints for managing the Piper TTS voice library.  Each
voice is a pair of files (.onnx model + .onnx.json config) stored in
``data/models/piper/``.  An optional ``.meta.json`` sidecar holds the
user-facing display name and description.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import wave

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from lokidoki.core.audio import (
    AudioConfig,
    VOICE_DIR,
    _VOICE_CACHE,
    synthesize_stream,
    voice_installed,
)
from lokidoki.auth.dependencies import current_user, require_admin
from lokidoki.auth.users import User

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("")
async def list_voices(_: User = Depends(current_user)):
    """List all installed Piper voices with file sizes."""
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    voices: list[dict] = []
    seen: set[str] = set()
    for onnx_file in sorted(VOICE_DIR.glob("*.onnx")):
        if onnx_file.name.endswith(".onnx.json"):
            continue
        voice_id = onnx_file.stem
        if voice_id in seen:
            continue
        seen.add(voice_id)
        config_file = VOICE_DIR / f"{voice_id}.onnx.json"
        meta_file = VOICE_DIR / f"{voice_id}.meta.json"
        display_name = voice_id
        description = ""
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text())
                display_name = meta.get("display_name", voice_id)
                description = meta.get("description", "")
            except Exception:
                pass
        voices.append({
            "voice_id": voice_id,
            "display_name": display_name,
            "description": description,
            "has_config": config_file.exists(),
            "model_size": onnx_file.stat().st_size if onnx_file.exists() else 0,
            "config_size": config_file.stat().st_size if config_file.exists() else 0,
        })
    return {"voices": voices}


@router.post("/upload")
async def upload_voice(
    model_file: UploadFile = File(...),
    config_file: UploadFile = File(...),
    display_name: str = Form(""),
    description: str = Form(""),
    _: User = Depends(require_admin),
):
    """Upload a Piper voice (.onnx + .onnx.json pair)."""
    if not model_file.filename or not model_file.filename.endswith(".onnx"):
        raise HTTPException(status_code=400, detail="Model file must be a .onnx file")
    if not config_file.filename or not config_file.filename.endswith(".onnx.json"):
        raise HTTPException(status_code=400, detail="Config file must be a .onnx.json file")

    voice_id = model_file.filename.removesuffix(".onnx")
    VOICE_DIR.mkdir(parents=True, exist_ok=True)

    model_bytes = await model_file.read()
    config_bytes = await config_file.read()

    (VOICE_DIR / f"{voice_id}.onnx").write_bytes(model_bytes)
    (VOICE_DIR / f"{voice_id}.onnx.json").write_bytes(config_bytes)

    meta = {
        "display_name": display_name.strip() or voice_id,
        "description": description.strip(),
    }
    (VOICE_DIR / f"{voice_id}.meta.json").write_text(json.dumps(meta, indent=2))

    _VOICE_CACHE.pop(voice_id, None)

    return {
        "status": "uploaded",
        "voice_id": voice_id,
        "model_size": len(model_bytes),
        "config_size": len(config_bytes),
    }


@router.put("/{voice_id}/meta")
async def update_voice_meta(
    voice_id: str,
    body: dict,
    _: User = Depends(require_admin),
):
    """Update display_name and description for an installed voice."""
    if not voice_installed(voice_id):
        raise HTTPException(status_code=404, detail=f"Voice '{voice_id}' not found")
    meta_path = VOICE_DIR / f"{voice_id}.meta.json"
    existing: dict = {}
    if meta_path.exists():
        try:
            existing = json.loads(meta_path.read_text())
        except Exception:
            pass
    if "display_name" in body:
        existing["display_name"] = str(body["display_name"]).strip() or voice_id
    if "description" in body:
        existing["description"] = str(body["description"]).strip()
    meta_path.write_text(json.dumps(existing, indent=2))
    return {"status": "updated", "voice_id": voice_id, **existing}


@router.delete("/{voice_id}")
async def delete_voice(
    voice_id: str,
    _: User = Depends(require_admin),
):
    """Delete a Piper voice and its files."""
    if not voice_installed(voice_id):
        raise HTTPException(status_code=404, detail=f"Voice '{voice_id}' not found")
    for suffix in (".onnx", ".onnx.json", ".meta.json"):
        path = VOICE_DIR / f"{voice_id}{suffix}"
        if path.exists():
            path.unlink()
    _VOICE_CACHE.pop(voice_id, None)
    return {"status": "deleted", "voice_id": voice_id}


def _synthesize_to_wav(text: str, voice_id: str, speech_rate: float) -> io.BytesIO:
    """Run Piper synthesis (CPU-bound) and return a WAV buffer.

    Must be called from a thread — not the async event loop.
    """
    config = AudioConfig(speech_rate=speech_rate)
    pcm_chunks: list[bytes] = []
    sample_rate = 22050
    for chunk in synthesize_stream(text, voice_id, config=config):
        pcm_chunks.append(chunk["audio_pcm"])
        sample_rate = chunk["sample_rate"]
    if not pcm_chunks:
        raise RuntimeError("Synthesis produced no audio")
    wav_buffer = io.BytesIO()
    with wave.open(wav_buffer, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(b"".join(pcm_chunks))
    wav_buffer.seek(0)
    return wav_buffer


@router.post("/{voice_id}/test")
async def test_voice(
    voice_id: str,
    text: str = Form(...),
    speech_rate: float = Form(1.0),
    _: User = Depends(require_admin),
):
    """Synthesize text with a specific voice and return a downloadable WAV."""
    if not voice_installed(voice_id):
        raise HTTPException(status_code=404, detail=f"Voice '{voice_id}' not found")
    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text must not be empty")

    try:
        loop = asyncio.get_running_loop()
        wav_buffer = await loop.run_in_executor(
            None, _synthesize_to_wav, text, voice_id, speech_rate,
        )
    except Exception as exc:
        logger.exception("Voice test synthesis failed for %s", voice_id)
        raise HTTPException(
            status_code=500,
            detail=f"Synthesis failed: {exc}",
        ) from exc

    return StreamingResponse(
        wav_buffer,
        media_type="audio/wav",
        headers={"Content-Disposition": f'attachment; filename="{voice_id}_test.wav"'},
    )
