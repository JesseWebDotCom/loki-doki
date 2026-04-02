"""Speech-to-text helpers for push-to-talk."""

from __future__ import annotations

import base64
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any


class VoiceTranscriptionError(RuntimeError):
    """Raised when local speech transcription fails."""


_MODEL_LOCK = threading.Lock()
_WHISPER_MODELS: dict[tuple[str, str], Any] = {}


def transcribe_audio(audio_base64: str, mime_type: str, model_label: str) -> str:
    """Transcribe a recorded audio payload using the configured local CPU STT backend."""
    audio_bytes = _decode_audio(audio_base64)
    backend, model_name = _parse_model_label(model_label)
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_root = Path(temp_dir)
        source_path = temp_root / _source_filename(mime_type)
        wav_path = temp_root / "speech.wav"
        source_path.write_bytes(audio_bytes)
        _normalize_audio(source_path, wav_path)
        if backend == "whisper_cpp":
            return _transcribe_with_whisper_cpp(wav_path, model_name)
        return _transcribe_with_faster_whisper(wav_path, model_name)


def _decode_audio(audio_base64: str) -> bytes:
    payload = audio_base64.strip()
    if not payload:
        raise VoiceTranscriptionError("Recorded audio was empty.")
    try:
        return base64.b64decode(payload)
    except Exception as exc:  # pragma: no cover - defensive wrapper
        raise VoiceTranscriptionError("Recorded audio could not be decoded.") from exc


def _source_filename(mime_type: str) -> str:
    if "mp4" in mime_type or "aac" in mime_type:
        return "speech.m4a"
    if "ogg" in mime_type:
        return "speech.ogg"
    return "speech.webm"


def _parse_model_label(model_label: str) -> tuple[str, str]:
    normalized = model_label.strip()
    if normalized.startswith("whisper.cpp "):
        return ("whisper_cpp", normalized.removeprefix("whisper.cpp ").strip() or "base.en")
    if normalized.startswith("faster-whisper "):
        return ("faster_whisper", normalized.removeprefix("faster-whisper ").strip() or "base.en")
    return ("faster_whisper", "base.en")


def _normalize_audio(source_path: Path, wav_path: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise VoiceTranscriptionError("ffmpeg is required for push-to-talk audio conversion.")
    try:
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-i",
                str(source_path),
                "-ac",
                "1",
                "-ar",
                "16000",
                str(wav_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.strip() or exc.stdout.strip() or str(exc)
        raise VoiceTranscriptionError(f"Audio conversion failed: {detail}") from exc


def _transcribe_with_faster_whisper(wav_path: Path, model_name: str) -> str:
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover - import guard
        raise VoiceTranscriptionError("faster-whisper is not installed in the active app environment.") from exc

    cache_key = ("faster_whisper", model_name)
    with _MODEL_LOCK:
        model = _WHISPER_MODELS.get(cache_key)
        if model is None:
            model = WhisperModel(model_name, device="cpu", compute_type="int8")
            _WHISPER_MODELS[cache_key] = model
    try:
        segments, _info = model.transcribe(str(wav_path), vad_filter=True, language="en")
        transcript = " ".join(segment.text.strip() for segment in segments).strip()
    except Exception as exc:  # pragma: no cover - inference wrapper
        raise VoiceTranscriptionError(f"Speech transcription failed: {exc}") from exc
    if not transcript:
        raise VoiceTranscriptionError("No speech was detected in the recording.")
    return transcript


def _transcribe_with_whisper_cpp(wav_path: Path, model_name: str) -> str:
    binary = shutil.which("whisper-cli") or shutil.which("whisper_cpp") or shutil.which("whisper")
    if not binary:
        return _transcribe_with_faster_whisper(wav_path, model_name)
    model_path = _resolve_whisper_cpp_model_path(model_name)
    if not model_path.exists():
        return _transcribe_with_faster_whisper(wav_path, model_name)
    try:
        result = subprocess.run(
            [
                binary,
                "-m",
                str(model_path),
                "-f",
                str(wav_path),
                "-l",
                "en",
                "-nt",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.strip() or exc.stdout.strip() or str(exc)
        raise VoiceTranscriptionError(f"whisper.cpp transcription failed: {detail}") from exc
    transcript = _clean_whisper_cpp_output(result.stdout)
    if not transcript:
        raise VoiceTranscriptionError("No speech was detected in the recording.")
    return transcript


def _resolve_whisper_cpp_model_path(model_name: str) -> Path:
    candidates = [
        Path.cwd() / ".lokidoki" / "whisper.cpp" / f"ggml-{model_name}.bin",
        Path.cwd() / ".lokidoki" / "models" / "whisper.cpp" / f"ggml-{model_name}.bin",
        Path.cwd() / "assets" / "models" / "whisper_cpp" / f"ggml-{model_name}.bin",
        Path.cwd() / "assets" / "models" / "whisper.cpp" / f"ggml-{model_name}.bin",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def _clean_whisper_cpp_output(raw: str) -> str:
    lines = []
    for line in raw.splitlines():
        cleaned = line.strip()
        if not cleaned or cleaned.startswith("[") or cleaned.startswith("whisper_"):
            continue
        lines.append(cleaned)
    return " ".join(lines).strip()
