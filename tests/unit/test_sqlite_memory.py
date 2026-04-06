import pytest
import os
from lokidoki.core.sqlite_memory import SQLiteMemoryProvider


@pytest.fixture
async def db(tmp_path):
    provider = SQLiteMemoryProvider(db_path=str(tmp_path / "test.db"))
    await provider.initialize()
    yield provider
    await provider.close()


class TestSQLiteMemoryProvider:
    @pytest.mark.anyio
    async def test_add_and_get_messages(self, db):
        """Test adding and retrieving chat messages."""
        await db.add_message("session_1", "user", "Hello")
        await db.add_message("session_1", "assistant", "Hi there!")

        messages = await db.get_messages("session_1")
        assert len(messages) == 2
        assert messages[0]["role"] == "user"
        assert messages[1]["content"] == "Hi there!"

    @pytest.mark.anyio
    async def test_messages_isolated_by_session(self, db):
        """Test that messages are scoped to their session."""
        await db.add_message("session_1", "user", "Hello from 1")
        await db.add_message("session_2", "user", "Hello from 2")

        s1 = await db.get_messages("session_1")
        s2 = await db.get_messages("session_2")
        assert len(s1) == 1
        assert len(s2) == 1
        assert s1[0]["content"] == "Hello from 1"

    @pytest.mark.anyio
    async def test_get_recent_messages(self, db):
        """Test retrieving only the N most recent messages."""
        for i in range(10):
            await db.add_message("session_1", "user", f"Message {i}")

        recent = await db.get_messages("session_1", limit=3)
        assert len(recent) == 3
        assert recent[0]["content"] == "Message 7"

    @pytest.mark.anyio
    async def test_add_and_get_facts(self, db):
        """Test adding and retrieving identity facts."""
        await db.add_fact("identity", "User is named Jesse")
        await db.add_fact("family", "Brother Billy loves Incredibles")

        facts = await db.get_all_facts()
        assert len(facts) == 2

    @pytest.mark.anyio
    async def test_no_duplicate_facts(self, db):
        """Test that identical facts are deduplicated."""
        await db.add_fact("identity", "User is named Jesse")
        await db.add_fact("identity", "User is named Jesse")

        facts = await db.get_all_facts()
        assert len(facts) == 1

    @pytest.mark.anyio
    async def test_search_facts(self, db):
        """Test keyword search over facts."""
        await db.add_fact("identity", "User is named Jesse")
        await db.add_fact("family", "Brother Billy loves Incredibles")
        await db.add_fact("preference", "User enjoys hiking")

        results = await db.search_facts("Billy")
        assert len(results) == 1
        assert "Billy" in results[0]["fact"]

    @pytest.mark.anyio
    async def test_search_facts_case_insensitive(self, db):
        """Test case-insensitive fact search."""
        await db.add_fact("identity", "User is named JESSE")
        results = await db.search_facts("jesse")
        assert len(results) == 1

    @pytest.mark.anyio
    async def test_update_sentiment(self, db):
        """Test storing and retrieving session sentiment."""
        await db.update_sentiment("session_1", "curious", "weather concern")
        sentiment = await db.get_sentiment("session_1")
        assert sentiment["sentiment"] == "curious"
        assert sentiment["concern"] == "weather concern"

    @pytest.mark.anyio
    async def test_sentiment_overwrites(self, db):
        """Test that sentiment update replaces previous."""
        await db.update_sentiment("session_1", "happy", "none")
        await db.update_sentiment("session_1", "worried", "rain")
        sentiment = await db.get_sentiment("session_1")
        assert sentiment["sentiment"] == "worried"

    @pytest.mark.anyio
    async def test_get_recent_facts_across_sessions(self, db):
        """Test retrieving recent facts for cross-chat restoration."""
        await db.add_fact("identity", "Name is Jesse")
        await db.add_fact("preference", "Likes hiking")
        await db.add_fact("family", "Brother is Billy")

        recent = await db.get_recent_facts(limit=2)
        assert len(recent) == 2

    @pytest.mark.anyio
    async def test_list_sessions(self, db):
        """Test listing all session IDs."""
        await db.add_message("session_a", "user", "Hello")
        await db.add_message("session_b", "user", "Hi")
        await db.add_message("session_a", "user", "World")

        sessions = await db.list_sessions()
        assert len(sessions) == 2
        assert "session_a" in sessions
        assert "session_b" in sessions

    @pytest.mark.anyio
    async def test_delete_session(self, db):
        """Test deleting a session and its messages."""
        await db.add_message("session_1", "user", "Hello")
        await db.update_sentiment("session_1", "happy", "")
        await db.delete_session("session_1")

        messages = await db.get_messages("session_1")
        assert len(messages) == 0

    @pytest.mark.anyio
    async def test_empty_search_returns_empty(self, db):
        """Test that searching with no facts returns empty list."""
        results = await db.search_facts("anything")
        assert results == []
