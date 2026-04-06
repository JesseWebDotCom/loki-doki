import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from httpx import AsyncClient, ASGITransport
from lokidoki.main import app
from lokidoki.core.sqlite_memory import SQLiteMemoryProvider
from lokidoki.core.bm25 import BM25Index
from lokidoki.core.context_restore import ContextRestorer


@pytest.fixture(autouse=True)
async def mock_memory_deps(tmp_path):
    """Mock the memory module singletons for testing."""
    db = SQLiteMemoryProvider(db_path=str(tmp_path / "test.db"))
    await db.initialize()
    await db.add_fact("identity", "User is named Jesse")
    await db.add_fact("family", "Brother Billy loves Incredibles")
    await db.add_message("session_test", "user", "Hello")
    await db.add_message("session_test", "assistant", "Hi there!")
    await db.update_sentiment("session_test", "happy", "none")

    bm25 = BM25Index()
    restorer = ContextRestorer(db=db, bm25=bm25)
    await restorer.rebuild_index()

    with patch("lokidoki.api.routes.memory.get_db", new_callable=lambda: lambda: AsyncMock(return_value=db)):
        with patch("lokidoki.api.routes.memory.get_restorer", new_callable=lambda: lambda: AsyncMock(return_value=restorer)):
            # Override the async functions directly
            import lokidoki.api.routes.memory as mem_module
            mem_module._db = db
            mem_module._restorer = restorer
            original_get_db = mem_module.get_db
            original_get_restorer = mem_module.get_restorer

            async def patched_get_db():
                return db

            async def patched_get_restorer():
                return restorer

            mem_module.get_db = patched_get_db
            mem_module.get_restorer = patched_get_restorer
            yield
            mem_module.get_db = original_get_db
            mem_module.get_restorer = original_get_restorer

    await db.close()


@pytest.mark.anyio
async def test_get_facts():
    """Test GET /api/v1/memory/facts returns stored facts."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/api/v1/memory/facts")

    assert response.status_code == 200
    data = response.json()
    assert len(data["facts"]) == 2


@pytest.mark.anyio
async def test_search_facts():
    """Test GET /api/v1/memory/facts/search with BM25."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/api/v1/memory/facts/search", params={"q": "Billy"})

    assert response.status_code == 200
    data = response.json()
    assert len(data["results"]) > 0


@pytest.mark.anyio
async def test_list_sessions():
    """Test GET /api/v1/memory/sessions lists sessions."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/api/v1/memory/sessions")

    assert response.status_code == 200
    data = response.json()
    assert "session_test" in data["sessions"]


@pytest.mark.anyio
async def test_get_session_messages():
    """Test GET /api/v1/memory/sessions/{id}/messages."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/api/v1/memory/sessions/session_test/messages")

    assert response.status_code == 200
    data = response.json()
    assert len(data["messages"]) == 2


@pytest.mark.anyio
async def test_get_context_restoration():
    """Test GET /api/v1/memory/context returns restoration data."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/api/v1/memory/context", params={"q": "Billy"})

    assert response.status_code == 200
    data = response.json()
    assert "rolling_context" in data
    assert "relevant_facts" in data
