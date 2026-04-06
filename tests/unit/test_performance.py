import pytest
from lokidoki.core.compression import compress_text
from lokidoki.core.bm25 import BM25Index
from lokidoki.core.model_manager import ModelPolicy


class TestCavemanCompressionPerformance:
    """Verify compression reduces token count for Pi 5 KV cache efficiency."""

    def test_compression_ratio(self):
        """Test that compression achieves meaningful token reduction."""
        input_text = (
            "The weather forecast for today is looking really nice and "
            "it will be a very sunny day with temperatures around 25 degrees "
            "celsius in the afternoon hours."
        )
        compressed = compress_text(input_text)
        original_tokens = len(input_text.split())
        compressed_tokens = len(compressed.split())

        # Should reduce by at least 30%
        ratio = compressed_tokens / original_tokens
        assert ratio < 0.7

    def test_compression_preserves_critical_info(self):
        """Test that critical modifiers survive compression."""
        text = "The temperature is not going to be above 25 degrees today but it might rain tomorrow"
        compressed = compress_text(text)
        assert "not" in compressed
        assert "25" in compressed
        assert "today" in compressed
        assert "but" in compressed
        assert "tomorrow" in compressed

    def test_compression_strips_html_noise(self):
        """Test HTML and citation noise removal."""
        text = "<div class='wrapper'><p>The answer is 42 [1] and confirmed [src:2]</p></div>"
        compressed = compress_text(text)
        assert "<" not in compressed
        assert "[1]" not in compressed
        assert "[src:2]" not in compressed
        assert "42" in compressed


class TestBM25Performance:
    """Verify BM25 performance characteristics for Pi 5."""

    def test_index_1000_documents(self):
        """Test that BM25 handles 1000 documents efficiently."""
        idx = BM25Index()
        for i in range(1000):
            idx.add_document(f"doc_{i}", f"This is fact number {i} about topic {i % 50}")

        assert idx.doc_count == 1000
        results = idx.search("fact topic 25")
        assert len(results) > 0

    def test_search_returns_top_k(self):
        """Test that search respects top_k limit."""
        idx = BM25Index()
        for i in range(100):
            idx.add_document(f"doc_{i}", f"common word unique{i}")

        results = idx.search("common word", top_k=5)
        assert len(results) == 5


class TestModelResidencyPolicy:
    """Verify model switching policy for Pi 5 RAM management."""

    def test_fast_model_stays_resident(self):
        """Test that fast model has keep_alive=-1 (permanent resident)."""
        policy = ModelPolicy()
        _, keep_alive = policy.select("fast")
        assert keep_alive == -1

    def test_thinking_model_has_timeout(self):
        """Test that thinking model frees RAM after timeout."""
        policy = ModelPolicy()
        _, keep_alive = policy.select("thinking")
        assert keep_alive == "5m"

    def test_default_falls_to_fast(self):
        """Test that unknown complexity defaults to resident fast model."""
        policy = ModelPolicy()
        model, keep_alive = policy.select("unrecognized")
        assert model == "gemma4:e2b"
        assert keep_alive == -1
