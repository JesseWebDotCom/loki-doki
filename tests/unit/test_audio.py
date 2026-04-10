import pytest
import asyncio
from unittest.mock import AsyncMock, patch, MagicMock
from lokidoki.core.audio import (
    SpeechToText, AudioConfig, SentenceBuffer, synthesize_stream
)
# NOTE: TextToSpeech was refactored away in favor of the module-level
# `synthesize_stream` / `warm_voice` functions; the legacy
# TestTextToSpeech tests below were removed alongside the class.


class TestAudioConfig:
    def test_default_config(self):
        config = AudioConfig()
        assert config.piper_voice == "en_US-lessac-medium"
        assert config.stt_model == "base"
        assert config.read_aloud is True
        assert config.speech_rate == 1.0
        assert config.sentence_pause == 0.4
        assert config.normalize_text is True

    def test_custom_config(self):
        config = AudioConfig(
            piper_voice="en_US-amy-low",
            read_aloud=False,
            speech_rate=1.15,
            sentence_pause=0.6,
            normalize_text=False,
        )
        assert config.piper_voice == "en_US-amy-low"
        assert config.read_aloud is False
        assert config.speech_rate == 1.15
        assert config.sentence_pause == 0.6
        assert config.normalize_text is False


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


class _FakeChunk:
    def __init__(self, text: str, sample_rate: int = 22050):
        self.audio_int16_bytes = (text.encode("utf-8") or b"x")[:6]
        if len(self.audio_int16_bytes) % 2:
            self.audio_int16_bytes += b"\x00"
        self.sample_rate = sample_rate
        self.phonemes = ["AA", "BB"]


class _FakeVoice:
    def __init__(self):
        self.calls = []

    def synthesize(self, text: str, **kwargs):
        self.calls.append({"text": text, **kwargs})
        yield _FakeChunk(text)


def test_synthesize_stream_normalizes_and_segments_text():
    voice = _FakeVoice()

    with patch("lokidoki.core.audio._cached_voice", return_value=voice):
        chunks = list(
            synthesize_stream(
                "Dr. Kim is at 04/09/2026. Also, we're 85% done.",
                "en_US-lessac-medium",
            )
        )

    assert len(voice.calls) == 2
    assert voice.calls[0]["text"] == "Doctor Kim is at April ninth, twenty twenty-six."
    assert voice.calls[0]["length_scale"] == 1.0
    assert voice.calls[1]["text"] == "Also, we're eighty-five percent done."
    assert voice.calls[1]["length_scale"] == 0.95
    assert len(chunks) == 3


def test_synthesize_stream_injects_silence_between_segments():
    voice = _FakeVoice()

    with patch("lokidoki.core.audio._cached_voice", return_value=voice):
        chunks = list(synthesize_stream("Yes. What now?", "en_US-lessac-medium"))

    assert len(chunks) == 3
    assert chunks[1]["phonemes"] == []
    assert chunks[1]["samples_per_phoneme"] == 0
    assert chunks[1]["audio_pcm"].startswith(b"\x00\x00")


def test_synthesize_stream_can_disable_normalization():
    voice = _FakeVoice()
    config = AudioConfig(normalize_text=False)

    with patch("lokidoki.core.audio._cached_voice", return_value=voice):
        list(synthesize_stream("Dr. Kim", "en_US-lessac-medium", config=config))

    assert voice.calls[0]["text"] == "Dr. Kim"
