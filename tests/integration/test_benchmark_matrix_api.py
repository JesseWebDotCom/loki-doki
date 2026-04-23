"""Integration tests for POST /api/v1/dev/pipeline/matrix and GET /dev/pipeline/corpus.

Matrix mode runs N prompts x M configs and returns aggregate stats
(p50/p95/mean, error_rate) so the dev tools UI can compare models
and modes without 3-card single-prompt runs.
"""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from lokidoki.core import memory_singleton
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.main import app


@pytest.fixture(autouse=True)
async def _fresh_memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "bench_api.db"))
    await mp.initialize()
    memory_singleton.set_memory_provider(mp)
    yield mp
    app.dependency_overrides.clear()
    memory_singleton.set_memory_provider(None)
    await mp.close()


def _client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _admin_override() -> User:
    return User(
        id=1,
        username="rey",
        role="admin",
        status="active",
        last_password_auth_at=1,
    )


@pytest.mark.anyio
async def test_corpus_endpoint_requires_admin_auth() -> None:
    async with _client() as ac:
        r = await ac.get("/api/v1/dev/pipeline/corpus")
    assert r.status_code == 409


@pytest.mark.anyio
async def test_matrix_endpoint_requires_admin_auth() -> None:
    async with _client() as ac:
        r = await ac.post(
            "/api/v1/dev/pipeline/matrix",
            json={"prompts": ["hi"], "configs": [{"label": "baseline"}]},
        )
    assert r.status_code == 409


@pytest.mark.anyio
async def test_corpus_endpoint_returns_six_categories(_fresh_memory) -> None:
    app.dependency_overrides[require_admin] = _admin_override
    await _fresh_memory.get_or_create_user("rey")
    async with _client() as ac:
        r = await ac.get("/api/v1/dev/pipeline/corpus")

    assert r.status_code == 200, r.text
    body = r.json()
    categories = {entry["category"] for entry in body["categories"]}
    assert {"math", "science", "arts", "entertainment", "technology", "nonsense"} <= categories


@pytest.mark.anyio
async def test_matrix_runs_every_prompt_x_config_and_aggregates(_fresh_memory) -> None:
    """Core matrix: 2 prompts x 2 configs -> 4 runs, with per-config aggregate stats."""
    app.dependency_overrides[require_admin] = _admin_override
    await _fresh_memory.get_or_create_user("rey")

    prompts = [
        {"id": "m.1", "prompt": "hello there"},
        {"id": "m.2", "prompt": "how do you spell restaurant"},
    ]
    configs = [
        {"label": "system_floor", "llm_mode": "system_only", "reasoning_mode": "fast"},
        {"label": "auto_default", "llm_mode": "auto", "reasoning_mode": "fast"},
    ]

    async with _client() as ac:
        r = await ac.post(
            "/api/v1/dev/pipeline/matrix",
            json={"prompts": prompts, "configs": configs},
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["configs"]) == 2
    labels = {cfg["label"] for cfg in body["configs"]}
    assert labels == {"system_floor", "auto_default"}

    for cfg in body["configs"]:
        assert len(cfg["runs"]) == 2
        for run in cfg["runs"]:
            assert run["prompt_id"] in {"m.1", "m.2"}
            assert "total_timing_ms" in run
            assert "llm_used" in run
            assert "error" in run  # None when the run succeeded
        stats = cfg["stats"]
        assert stats["count"] + stats["errors"] == 2
        assert stats["p50_ms"] >= 0
        assert stats["p95_ms"] >= stats["p50_ms"]
        assert 0.0 <= stats["error_rate"] <= 1.0


@pytest.mark.anyio
async def test_matrix_rejects_empty_prompts(_fresh_memory) -> None:
    app.dependency_overrides[require_admin] = _admin_override
    await _fresh_memory.get_or_create_user("rey")
    async with _client() as ac:
        r = await ac.post(
            "/api/v1/dev/pipeline/matrix",
            json={"prompts": [], "configs": [{"label": "x"}]},
        )
    assert r.status_code == 422


@pytest.mark.anyio
async def test_matrix_rejects_empty_configs(_fresh_memory) -> None:
    app.dependency_overrides[require_admin] = _admin_override
    await _fresh_memory.get_or_create_user("rey")
    async with _client() as ac:
        r = await ac.post(
            "/api/v1/dev/pipeline/matrix",
            json={"prompts": [{"id": "a", "prompt": "hi"}], "configs": []},
        )
    assert r.status_code == 422


@pytest.mark.anyio
async def test_matrix_caps_total_runs_to_limit(_fresh_memory) -> None:
    """Hard cap so a careless user can't kick off 10k runs by accident."""
    app.dependency_overrides[require_admin] = _admin_override
    await _fresh_memory.get_or_create_user("rey")
    # Cap is 1500 (enough for the full fixture corpus x ~12 configs).
    # 150 prompts x 12 configs = 1800, safely over.
    prompts = [{"id": f"p.{i}", "prompt": f"test {i}"} for i in range(150)]
    configs = [{"label": f"c.{j}"} for j in range(12)]
    async with _client() as ac:
        r = await ac.post(
            "/api/v1/dev/pipeline/matrix",
            json={"prompts": prompts, "configs": configs},
        )
    assert r.status_code == 422
    assert "limit" in r.text.lower() or "exceed" in r.text.lower()


@pytest.mark.anyio
async def test_matrix_grades_prompts_with_expected_keywords(_fresh_memory) -> None:
    """Per-run grading plus config-level accuracy over all graded prompts."""
    app.dependency_overrides[require_admin] = _admin_override
    await _fresh_memory.get_or_create_user("rey")

    prompts = [
        # system_only echoes a canned hello -> output contains "hello".
        {
            "id": "grade.hit",
            "prompt": "hello there",
            "expected": {"any_of": ["hello"]},
        },
        # "banana" will not appear in a greeting -> graded as incorrect.
        {
            "id": "grade.miss",
            "prompt": "hello there",
            "expected": {"any_of": ["banana"]},
        },
        # No expected spec -> ungraded; accuracy denominator must ignore it.
        {"id": "grade.ungraded", "prompt": "hello there"},
    ]
    configs = [{"label": "baseline", "llm_mode": "system_only", "reasoning_mode": "fast"}]

    async with _client() as ac:
        r = await ac.post(
            "/api/v1/dev/pipeline/matrix",
            json={"prompts": prompts, "configs": configs},
        )

    assert r.status_code == 200, r.text
    body = r.json()
    cfg = body["configs"][0]
    by_id = {run["prompt_id"]: run for run in cfg["runs"]}

    assert by_id["grade.hit"]["graded"] is True
    assert by_id["grade.hit"]["correct"] is True
    assert by_id["grade.hit"]["matches"] == ["hello"]

    assert by_id["grade.miss"]["graded"] is True
    assert by_id["grade.miss"]["correct"] is False
    assert by_id["grade.miss"]["matches"] == []

    assert by_id["grade.ungraded"]["graded"] is False
    assert by_id["grade.ungraded"]["correct"] is None

    stats = cfg["stats"]
    assert stats["graded_count"] == 2
    assert stats["correct_count"] == 1
    assert stats["accuracy_rate"] == pytest.approx(0.5)
