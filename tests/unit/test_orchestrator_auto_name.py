"""Auto-naming unit test for Orchestrator._auto_name_session."""
import pytest
from unittest.mock import AsyncMock

from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "auto_name.db"))
    await mp.initialize()
    yield mp
    await mp.close()


def _build_orch(memory, generate_return: str):
    mock_decomposer = AsyncMock()
    mock_inference = AsyncMock()
    mock_inference.generate = AsyncMock(return_value=generate_return)
    policy = ModelPolicy(platform="mac")
    mm = ModelManager(inference_client=mock_inference, policy=policy)
    return Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=mm,
    ), mock_inference


class TestAutoNameSession:
    @pytest.mark.anyio
    async def test_writes_generated_title(self, memory):
        uid = await memory.get_or_create_user("default")
        sid = await memory.create_session(uid, "")
        orch, infer = _build_orch(memory, generate_return="Nuclear Reactor Duct Tape")
        await orch._auto_name_session(uid, sid, "How do I build a nuclear reactor with duct tape?")
        sessions = await memory.list_sessions(uid)
        assert next(s for s in sessions if s["id"] == sid)["title"] == "Nuclear Reactor Duct Tape"
        infer.generate.assert_awaited_once()

    @pytest.mark.anyio
    async def test_strips_quotes_and_whitespace(self, memory):
        uid = await memory.get_or_create_user("default")
        sid = await memory.create_session(uid, "")
        orch, _ = _build_orch(memory, generate_return='  "My Cool Title"  ')
        await orch._auto_name_session(uid, sid, "anything")
        sessions = await memory.list_sessions(uid)
        assert next(s for s in sessions if s["id"] == sid)["title"] == "My Cool Title"

    @pytest.mark.anyio
    async def test_blank_title_does_not_overwrite(self, memory):
        uid = await memory.get_or_create_user("default")
        sid = await memory.create_session(uid, "Original")
        orch, _ = _build_orch(memory, generate_return="   ")
        await orch._auto_name_session(uid, sid, "anything")
        sessions = await memory.list_sessions(uid)
        assert next(s for s in sessions if s["id"] == sid)["title"] == "Original"

    @pytest.mark.anyio
    async def test_inference_failure_is_swallowed(self, memory):
        uid = await memory.get_or_create_user("default")
        sid = await memory.create_session(uid, "Original")
        orch, infer = _build_orch(memory, generate_return="ignored")
        infer.generate = AsyncMock(side_effect=RuntimeError("ollama down"))
        # must not raise
        await orch._auto_name_session(uid, sid, "anything")
        sessions = await memory.list_sessions(uid)
        assert next(s for s in sessions if s["id"] == sid)["title"] == "Original"
