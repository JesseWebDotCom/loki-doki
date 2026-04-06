import pytest
import json
import os
import tempfile
from lokidoki.core.memory import SessionMemory


@pytest.fixture
def memory():
    return SessionMemory()


@pytest.fixture
def persistent_memory(tmp_path):
    return SessionMemory(storage_path=str(tmp_path / "memory.json"))


class TestSessionMemory:
    def test_add_message(self, memory):
        """Test adding a message to session history."""
        memory.add_message("user", "Hello")
        assert len(memory.messages) == 1
        assert memory.messages[0]["role"] == "user"
        assert memory.messages[0]["content"] == "Hello"

    def test_message_history_ordering(self, memory):
        """Test that messages maintain chronological order."""
        memory.add_message("user", "First")
        memory.add_message("assistant", "Second")
        memory.add_message("user", "Third")
        assert [m["content"] for m in memory.messages] == ["First", "Second", "Third"]

    def test_get_recent_context(self, memory):
        """Test retrieval of recent N messages."""
        for i in range(10):
            memory.add_message("user", f"Message {i}")
        recent = memory.get_recent_context(n=5)
        assert len(recent) == 5
        assert recent[0]["content"] == "Message 5"
        assert recent[-1]["content"] == "Message 9"

    def test_get_recent_context_fewer_than_n(self, memory):
        """Test that fewer messages than N returns all available."""
        memory.add_message("user", "Only one")
        recent = memory.get_recent_context(n=10)
        assert len(recent) == 1

    def test_update_sentiment(self, memory):
        """Test updating session sentiment."""
        memory.update_sentiment({"sentiment": "happy", "concern": "none"})
        assert memory.sentiment["sentiment"] == "happy"

    def test_sentiment_overwrites_previous(self, memory):
        """Test that sentiment update replaces the previous state."""
        memory.update_sentiment({"sentiment": "happy", "concern": "none"})
        memory.update_sentiment({"sentiment": "worried", "concern": "rain"})
        assert memory.sentiment["sentiment"] == "worried"

    def test_add_fact(self, memory):
        """Test adding a long-term fact."""
        memory.add_fact({"category": "identity", "fact": "User is named Jesse"})
        assert len(memory.facts) == 1
        assert memory.facts[0]["fact"] == "User is named Jesse"

    def test_add_multiple_facts(self, memory):
        """Test adding multiple facts."""
        memory.add_fact({"category": "identity", "fact": "Name is Jesse"})
        memory.add_fact({"category": "family", "fact": "Has a brother Billy"})
        assert len(memory.facts) == 2

    def test_no_duplicate_facts(self, memory):
        """Test that identical facts are not duplicated."""
        fact = {"category": "identity", "fact": "User is named Jesse"}
        memory.add_fact(fact)
        memory.add_fact(fact)
        assert len(memory.facts) == 1

    def test_search_facts(self, memory):
        """Test keyword search over stored facts."""
        memory.add_fact({"category": "identity", "fact": "User is named Jesse"})
        memory.add_fact({"category": "family", "fact": "Brother Billy loves Incredibles"})
        memory.add_fact({"category": "preference", "fact": "User enjoys hiking"})

        results = memory.search_facts("Billy")
        assert len(results) == 1
        assert "Billy" in results[0]["fact"]

    def test_search_facts_case_insensitive(self, memory):
        """Test that fact search is case-insensitive."""
        memory.add_fact({"category": "identity", "fact": "User is named JESSE"})
        results = memory.search_facts("jesse")
        assert len(results) == 1

    def test_save_and_load(self, persistent_memory):
        """Test JSON persistence of session memory."""
        persistent_memory.add_message("user", "Hello")
        persistent_memory.update_sentiment({"sentiment": "happy", "concern": ""})
        persistent_memory.add_fact({"category": "identity", "fact": "Name is Jesse"})
        persistent_memory.save()

        loaded = SessionMemory(storage_path=persistent_memory._storage_path)
        loaded.load()

        assert len(loaded.messages) == 1
        assert loaded.sentiment["sentiment"] == "happy"
        assert len(loaded.facts) == 1

    def test_clear(self, memory):
        """Test clearing session memory (messages + sentiment, keeps facts)."""
        memory.add_message("user", "Hello")
        memory.update_sentiment({"sentiment": "happy", "concern": ""})
        memory.add_fact({"category": "identity", "fact": "Name is Jesse"})

        memory.clear_session()

        assert len(memory.messages) == 0
        assert memory.sentiment == {}
        # Facts persist across session clears
        assert len(memory.facts) == 1

    def test_ingest_decomposition_memory(self, memory):
        """Test ingesting sentiment + facts from a DecompositionResult."""
        memory.ingest_decomposition(
            short_term={"sentiment": "curious", "concern": "weather"},
            long_term=[{"category": "preference", "fact": "Likes rain"}],
        )
        assert memory.sentiment["sentiment"] == "curious"
        assert len(memory.facts) == 1
