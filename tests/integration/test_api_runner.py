import pytest
from httpx import AsyncClient, ASGITransport
from lokidoki.main import app

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
