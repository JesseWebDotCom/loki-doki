import asyncio
import re
from dataclasses import dataclass, field


@dataclass
class AudioConfig:
    """Audio system configuration."""
    piper_voice: str = "en_US-lessac-medium"
    stt_model: str = "base"
    read_aloud: bool = True
    piper_binary: str = "piper"
    whisper_binary: str = "faster-whisper"


class SentenceBuffer:
    """Collects streaming tokens and flushes complete sentences for TTS.

    Per DESIGN.md: sentence-buffered synthesis sends complete sentences
    to Piper as soon as end-markers are detected.
    """

    def __init__(self):
        self.remainder: str = ""

    def add_tokens(self, text: str) -> None:
        self.remainder += text

    def flush_sentences(self) -> list[str]:
        """Extract and return all complete sentences, keeping the remainder."""
        # Split on sentence boundaries (., !, ?)
        parts = re.split(r'(?<=[.!?])\s*', self.remainder)
        sentences = []
        self.remainder = ""

        for part in parts:
            part = part.strip()
            if not part:
                continue
            if part[-1] in '.!?':
                sentences.append(part)
            else:
                self.remainder = part

        return sentences

    def flush_final(self) -> str:
        """Flush any remaining text (end of stream)."""
        text = self.remainder.strip()
        self.remainder = ""
        return text


class SpeechToText:
    """Async wrapper for Faster-Whisper STT.

    CPU-bound on Pi 5, processes audio chunks for immediate text feedback.
    """

    def __init__(self, model: str = "base", binary: str = "faster-whisper"):
        self.model = model
        self._binary = binary

    async def transcribe(self, audio_path: str) -> str:
        """Transcribe an audio file to text."""
        try:
            process = await asyncio.create_subprocess_exec(
                self._binary, audio_path,
                "--model", self.model,
                "--output_format", "txt",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()

            if process.returncode != 0:
                return ""

            return stdout.decode().strip()
        except Exception:
            return ""

    async def is_available(self) -> bool:
        """Check if faster-whisper is installed and accessible."""
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


class TextToSpeech:
    """Async wrapper for Piper TTS.

    Optimized for CPU-only, real-time streaming on Pi 5.
    Uses ONNX-based voice models for professional cadence.
    """

    def __init__(self, voice: str = "en_US-lessac-medium", binary: str = "piper"):
        self.voice = voice
        self._binary = binary

    async def synthesize(self, text: str, output_path: str) -> bool:
        """Synthesize text to a WAV audio file."""
        try:
            process = await asyncio.create_subprocess_exec(
                self._binary,
                "--model", self.voice,
                "--output_file", output_path,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate(input=text.encode())
            return process.returncode == 0
        except Exception:
            return False

    async def is_available(self) -> bool:
        """Check if piper is installed and accessible."""
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
