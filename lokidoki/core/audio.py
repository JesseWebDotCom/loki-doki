"""In-process Piper TTS + Faster-Whisper STT helpers.

Synthesis is in-process via the `piper` Python package — no `piper` CLI
subprocess and no WAV-on-disk. The streaming generator yields raw PCM
chunks plus phoneme/sample alignment data so the browser can both play
audio immediately and drive a viseme timeline.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

VOICE_DIR = Path("data/models/piper")

DEFAULT_VOICE_ID = "en_US-lessac-medium"
_HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
DEFAULT_VOICE_URLS = {
    "model": f"{_HF_BASE}/en/en_US/lessac/medium/en_US-lessac-medium.onnx",
    "config": f"{_HF_BASE}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json",
}


def ensure_default_voice() -> dict[str, Any]:
    """Download the default Piper voice if it isn't on disk yet."""
    import urllib.request

    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    model_target = _model_path(DEFAULT_VOICE_ID)
    config_target = _config_path(DEFAULT_VOICE_ID)
    downloaded: list[str] = []
    if not model_target.exists():
        urllib.request.urlretrieve(DEFAULT_VOICE_URLS["model"], model_target)
        downloaded.append("model")
    if not config_target.exists():
        urllib.request.urlretrieve(DEFAULT_VOICE_URLS["config"], config_target)
        downloaded.append("config")
    return {
        "voice_id": DEFAULT_VOICE_ID,
        "downloaded": downloaded,
        "model_path": str(model_target),
        "config_path": str(config_target),
    }

_VOICE_CACHE: dict[str, Any] = {}
_VOICE_CACHE_LOCK = threading.Lock()


@dataclass
class AudioConfig:
    piper_voice: str = "en_US-lessac-medium"
    stt_model: str = "base"
    read_aloud: bool = True


# ---------------------------------------------------------------------------
# Piper streaming synthesis
# ---------------------------------------------------------------------------

def _model_path(voice_id: str) -> Path:
    return VOICE_DIR / f"{voice_id}.onnx"


def _config_path(voice_id: str) -> Path:
    return VOICE_DIR / f"{voice_id}.onnx.json"


def voice_installed(voice_id: str) -> bool:
    return _model_path(voice_id).exists() and _config_path(voice_id).exists()


@contextlib.contextmanager
def _suppress_stderr() -> Any:
    """Silence native-library stderr noise during model load."""
    try:
        saved = os.dup(2)
    except OSError:
        yield
        return
    try:
        with open(os.devnull, "w", encoding="utf-8") as devnull:
            os.dup2(devnull.fileno(), 2)
            yield
    finally:
        os.dup2(saved, 2)
        os.close(saved)


def _cached_voice(voice_id: str) -> Any:
    if voice_id in _VOICE_CACHE:
        return _VOICE_CACHE[voice_id]
    if not voice_installed(voice_id):
        raise RuntimeError(
            f"Piper voice '{voice_id}' is not installed at {VOICE_DIR}"
        )
    try:
        os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")
        from piper.voice import PiperVoice  # type: ignore
    except Exception as exc:
        raise RuntimeError("piper-tts python runtime is unavailable.") from exc
    with _VOICE_CACHE_LOCK:
        if voice_id not in _VOICE_CACHE:
            with _suppress_stderr():
                _VOICE_CACHE[voice_id] = PiperVoice.load(str(_model_path(voice_id)))
    return _VOICE_CACHE[voice_id]


def warm_voice(voice_id: str) -> bool:
    try:
        _cached_voice(voice_id)
        return True
    except Exception:
        return False


def synthesize_stream(text: str, voice_id: str) -> Iterator[dict[str, Any]]:
    """Yield {audio_pcm, sample_rate, phonemes, samples_per_phoneme} chunks.

    Each yielded chunk corresponds to one Piper synthesis segment (sentence-
    level). PCM is little-endian int16 mono, ready to play in an
    AudioBuffer on the browser side.
    """
    voice = _cached_voice(voice_id)
    for chunk in voice.synthesize(text):
        phonemes = list(chunk.phonemes) if getattr(chunk, "phonemes", None) else []
        sample_count = len(chunk.audio_int16_bytes) // 2
        samples_per_phoneme = sample_count // len(phonemes) if phonemes else 0
        yield {
            "audio_pcm": chunk.audio_int16_bytes,
            "sample_rate": int(chunk.sample_rate),
            "phonemes": phonemes,
            "samples_per_phoneme": samples_per_phoneme,
        }


# ---------------------------------------------------------------------------
# Faster-Whisper STT (unchanged shell wrapper)
# ---------------------------------------------------------------------------

class SpeechToText:
    def __init__(self, model: str = "base", binary: str = "faster-whisper"):
        self.model = model
        self._binary = binary

    async def transcribe(self, audio_path: str) -> str:
        try:
            process = await asyncio.create_subprocess_exec(
                self._binary, audio_path,
                "--model", self.model,
                "--output_format", "txt",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await process.communicate()
            if process.returncode != 0:
                return ""
            return stdout.decode().strip()
        except Exception:
            return ""

    async def is_available(self) -> bool:
        try:
            process = await asyncio.create_subprocess_exec(
                self._binary, "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await process.communicate()
            return process.returncode == 0
        except Exception:
            return False


# ---------------------------------------------------------------------------
# SentenceBuffer (kept for potential token-stream batching)
# ---------------------------------------------------------------------------

class SentenceBuffer:
    """Collects streaming tokens and flushes complete sentences."""

    def __init__(self) -> None:
        self.remainder: str = ""

    def add_tokens(self, text: str) -> None:
        self.remainder += text

    def flush_sentences(self) -> list[str]:
        parts = re.split(r"(?<=[.!?])\s*", self.remainder)
        sentences: list[str] = []
        self.remainder = ""
        for part in parts:
            part = part.strip()
            if not part:
                continue
            if part[-1] in ".!?":
                sentences.append(part)
            else:
                self.remainder = part
        return sentences

    def flush_final(self) -> str:
        text = self.remainder.strip()
        self.remainder = ""
        return text
