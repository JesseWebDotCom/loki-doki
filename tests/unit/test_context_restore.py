import pytest
from lokidoki.core.context_restore import ContextRestorer
from lokidoki.core.sqlite_memory import SQLiteMemoryProvider
from lokidoki.core.bm25 import BM25Index


@pytest.fixture
async def restorer(tmp_path):
    db = SQLiteMemoryProvider(db_path=str(tmp_path / "test.db"))
    await db.initialize()
    bm25 = BM25Index()
    restorer = ContextRestorer(db=db, bm25=bm25)

    # Populate with historical data
    await db.add_message("old_session", "user", "I live in Seattle")
    await db.add_message("old_session", "assistant", "Got it, Seattle!")
    await db.add_message("old_session", "user", "My brother Billy loves The Incredibles")
    await db.add_fact("identity", "User lives in Seattle")
    await db.add_fact("family", "Brother Billy loves The Incredibles")
    await db.add_fact("preference", "User enjoys hiking on weekends")

    # Index facts in BM25
    await restorer.rebuild_index()

    yield restorer
    await db.close()


class TestContextRestorer:
    @pytest.mark.anyio
    async def test_get_rolling_context(self, restorer):
        """Test that rolling context returns recent facts."""
        context = await restorer.get_rolling_context(limit=3)
        assert len(context) <= 3
        assert all("fact" in f for f in context)

    @pytest.mark.anyio
    async def test_search_relevant_facts(self, restorer):
        """Test BM25 search for relevant facts from user query."""
        results = restorer.search_relevant("Billy movie")
        assert len(results) > 0
        facts = [r[0] for r in results]
        assert any("Billy" in f for f in facts)

    @pytest.mark.anyio
    async def test_search_relevant_hiking(self, restorer):
        """Test BM25 retrieval for hiking-related query."""
        results = restorer.search_relevant("hiking trails this weekend")
        facts = [r[0] for r in results]
        assert any("hiking" in f.lower() for f in facts)

    @pytest.mark.anyio
    async def test_search_no_match(self, restorer):
        """Test that irrelevant queries return nothing."""
        results = restorer.search_relevant("quantum physics neutron star")
        assert len(results) == 0

    @pytest.mark.anyio
    async def test_rebuild_index_from_db(self, restorer):
        """Test that rebuild_index populates BM25 from SQLite facts."""
        assert restorer._bm25.doc_count == 3

    @pytest.mark.anyio
    async def test_add_fact_updates_both_stores(self, restorer):
        """Test that adding a fact updates both SQLite and BM25."""
        await restorer.add_fact("hobby", "User plays chess competitively")
        assert restorer._bm25.doc_count == 4

        results = restorer.search_relevant("chess")
        assert len(results) > 0

    @pytest.mark.anyio
    async def test_build_restoration_prompt(self, restorer):
        """Test building a context restoration prompt for new chats."""
        prompt = await restorer.build_restoration_prompt("What's the weather?")
        assert "Seattle" in prompt or "hiking" in prompt or "Billy" in prompt
        assert len(prompt) > 0
