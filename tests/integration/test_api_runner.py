import pytest
from httpx import AsyncClient, ASGITransport
from lokidoki.main import app
from lokidoki.core import memory_singleton
from lokidoki.core.memory_provider import MemoryProvider


@pytest.fixture(autouse=True)
async def _bootstrap_gate_satisfied(tmp_path):
    """The bootstrap gate middleware blocks all API routes when no users
    exist. /api/v1/tests doesn't authenticate, but it still has to clear
    the gate, so seed an isolated tmp DB with a single user."""
    mp = MemoryProvider(db_path=str(tmp_path / "runner.db"))
    await mp.initialize()
    await mp.get_or_create_user("dev")
    memory_singleton.set_memory_provider(mp)
    yield
    memory_singleton.set_memory_provider(None)
    await mp.close()

@pytest.mark.anyio
async def test_run_tests_endpoint():
    """Test the /run endpoint which triggers pytest."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # Pass a target to avoid recursive testing
        response = await ac.post("/api/v1/tests/run", json={"target": "tests/unit"})
    
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert "output" in data
    assert "summary" in data

@pytest.mark.anyio
async def test_get_test_status_endpoint():
    """Test the /status endpoint which returns previous test results."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/api/v1/tests/status")
    
    assert response.status_code == 200
    data = response.json()
    assert "last_run" in data
