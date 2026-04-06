import pytest
import asyncio
from unittest.mock import AsyncMock, patch, MagicMock
from lokidoki.core.audio import (
    SpeechToText, TextToSpeech, AudioConfig, SentenceBuffer
)


class TestAudioConfig:
    def test_default_config(self):
        config = AudioConfig()
        assert config.piper_voice == "en_US-lessac-medium"
        assert config.stt_model == "base"
        assert config.read_aloud is True

    def test_custom_config(self):
        config = AudioConfig(piper_voice="en_US-amy-low", read_aloud=False)
        assert config.piper_voice == "en_US-amy-low"
        assert config.read_aloud is False


class TestSentenceBuffer:
    def test_empty_buffer(self):
        buf = SentenceBuffer()
        assert buf.flush_sentences() == []
        assert buf.remainder == ""

    def test_single_sentence(self):
        buf = SentenceBuffer()
        buf.add_tokens("Hello world.")
        sentences = buf.flush_sentences()
        assert sentences == ["Hello world."]
        assert buf.remainder == ""

    def test_incomplete_sentence(self):
        buf = SentenceBuffer()
        buf.add_tokens("Hello world")
        sentences = buf.flush_sentences()
        assert sentences == []
        assert buf.remainder == "Hello world"

    def test_multiple_sentences(self):
        buf = SentenceBuffer()
        buf.add_tokens("First sentence. Second one! Third?")
        sentences = buf.flush_sentences()
        assert len(sentences) == 3
        assert sentences[0] == "First sentence."
        assert sentences[1] == "Second one!"
        assert sentences[2] == "Third?"

    def test_incremental_tokens(self):
        buf = SentenceBuffer()
        buf.add_tokens("Hello ")
        buf.add_tokens("world. ")

        sentences = buf.flush_sentences()
        assert sentences == ["Hello world."]

        buf.add_tokens("How are ")
        buf.add_tokens("you?")

        sentences = buf.flush_sentences()
        assert sentences == ["How are you?"]

    def test_preserves_whitespace_in_remainder(self):
        buf = SentenceBuffer()
        buf.add_tokens("Hello world. Still going")
        sentences = buf.flush_sentences()
        assert sentences == ["Hello world."]
        assert buf.remainder.strip() == "Still going"

    def test_final_flush(self):
        buf = SentenceBuffer()
        buf.add_tokens("No period here")
        text = buf.flush_final()
        assert text == "No period here"
        assert buf.remainder == ""


class TestSpeechToText:
    @pytest.mark.anyio
    async def test_transcribe_calls_whisper_subprocess(self):
        """Test that transcribe invokes faster-whisper via subprocess."""
        stt = SpeechToText(model="base")

        mock_process = MagicMock()
        mock_process.returncode = 0
        mock_process.stdout = b"Hello world\n"
        mock_process.stderr = b""

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_process) as mock_exec:
            mock_process.communicate = AsyncMock(return_value=(b"Hello world\n", b""))

            result = await stt.transcribe("/tmp/test.wav")

        assert result == "Hello world"

    @pytest.mark.anyio
    async def test_transcribe_handles_error(self):
        """Test graceful handling when whisper fails."""
        stt = SpeechToText(model="base")

        mock_process = MagicMock()
        mock_process.returncode = 1
        mock_process.communicate = AsyncMock(return_value=(b"", b"Error"))

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_process):
            result = await stt.transcribe("/tmp/test.wav")

        assert result == ""

    @pytest.mark.anyio
    async def test_stt_is_available_checks_binary(self):
        """Test availability check for faster-whisper."""
        stt = SpeechToText(model="base")

        mock_process = MagicMock()
        mock_process.returncode = 0
        mock_process.communicate = AsyncMock(return_value=(b"v0.10.0\n", b""))

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_process):
            available = await stt.is_available()

        assert available is True


class TestTextToSpeech:
    @pytest.mark.anyio
    async def test_synthesize_calls_piper_subprocess(self):
        """Test that synthesize invokes piper via subprocess."""
        tts = TextToSpeech(voice="en_US-lessac-medium")

        mock_process = MagicMock()
        mock_process.returncode = 0
        mock_process.communicate = AsyncMock(return_value=(b"\x00" * 100, b""))

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_process):
            result = await tts.synthesize("Hello world", "/tmp/output.wav")

        assert result is True

    @pytest.mark.anyio
    async def test_synthesize_handles_error(self):
        """Test graceful handling when piper fails."""
        tts = TextToSpeech(voice="en_US-lessac-medium")

        mock_process = MagicMock()
        mock_process.returncode = 1
        mock_process.communicate = AsyncMock(return_value=(b"", b"Error"))

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_process):
            result = await tts.synthesize("Hello world", "/tmp/output.wav")

        assert result is False

    @pytest.mark.anyio
    async def test_tts_is_available_checks_binary(self):
        """Test availability check for piper."""
        tts = TextToSpeech(voice="en_US-lessac-medium")

        mock_process = MagicMock()
        mock_process.returncode = 0
        mock_process.communicate = AsyncMock(return_value=(b"piper v1.2.0\n", b""))

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_process):
            available = await tts.is_available()

        assert available is True

    def test_voice_model_path(self):
        """Test voice model path generation."""
        tts = TextToSpeech(voice="en_US-lessac-medium")
        assert "en_US-lessac-medium" in tts.voice
