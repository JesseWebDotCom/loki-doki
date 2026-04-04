import pytest
from unittest.mock import MagicMock, AsyncMock, patch

from app.skills.builtins.core_memory.skill import CoreMemorySkill

@pytest.fixture
def skill():
    s = CoreMemorySkill()
    s.manifest = {
        "id": "core_memory",
        "actions": {
            "save_fact": {}
        }
    }
    return s

@pytest.fixture
def emit_progress():
    return AsyncMock()

@pytest.fixture
def ctx():
    # Mock context with a connection and user/character info
    return {
        "connection": MagicMock(),
        "user": {"id": "user_123"},
        "character": {"id": "lokidoki"}
    }

@pytest.mark.asyncio
async def test_save_fact_success(skill, emit_progress, ctx):
    # Mock the internal memory_store.write_memory function
    with patch("app.skills.builtins.core_memory.skill.memory_store.write_memory", return_value=True):
        result = await skill.execute(
            "save_fact", 
            ctx, 
            emit_progress, 
            key="likes", 
            value="pizza", 
            category="preferences", 
            confidence=1.0
        )
        
        assert result["ok"] is True
        assert result["data"]["key"] == "likes"
        assert result["data"]["value"] == "pizza"
        assert result["data"]["written"] is True
        assert result["meta"]["threshold_met"] is True

@pytest.mark.asyncio
async def test_save_fact_low_confidence(skill, emit_progress, ctx):
    # Mock low confidence returning false (not written)
    with patch("app.skills.builtins.core_memory.skill.memory_store.write_memory", return_value=False):
        result = await skill.execute(
            "save_fact", 
            ctx, 
            emit_progress, 
            key="visited", 
            value="Rome", 
            category="travel", 
            confidence=0.4
        )
        
        assert result["ok"] is True
        assert result["data"]["written"] is False
        assert result["meta"]["threshold_met"] is False
