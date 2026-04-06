import pytest
import asyncio
from unittest.mock import AsyncMock
from lokidoki.core.skill_executor import (
    BaseSkill, SkillResult, SkillExecutor, MechanismResult
)


class MockSkill(BaseSkill):
    """Test skill with configurable mechanism behavior."""

    def __init__(self, results: dict[str, MechanismResult]):
        self._results = results

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method in self._results:
            result = self._results[method]
            if isinstance(result, Exception):
                raise result
            return result
        raise ValueError(f"Unknown mechanism: {method}")


class SlowSkill(BaseSkill):
    """Test skill that delays mechanism execution."""

    def __init__(self, delay: float, result: MechanismResult):
        self._delay = delay
        self._result = result

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        await asyncio.sleep(self._delay)
        return self._result


class TestMechanismResult:
    def test_success_result(self):
        r = MechanismResult(success=True, data={"temp": 72}, source_url="https://api.owm.com")
        assert r.success is True
        assert r.data["temp"] == 72

    def test_failure_result(self):
        r = MechanismResult(success=False, error="timeout")
        assert r.success is False
        assert r.error == "timeout"


class TestSkillExecutor:
    @pytest.mark.anyio
    async def test_execute_prioritized_fallback(self):
        """Test that mechanisms are tried in priority order with fallback."""
        skill = MockSkill(results={
            "api": MechanismResult(success=False, error="network error"),
            "cache": MechanismResult(success=True, data={"cached": True}),
        })
        mechanisms = [
            {"method": "api", "priority": 1, "timeout_ms": 1000, "requires_internet": True},
            {"method": "cache", "priority": 2, "timeout_ms": 500, "requires_internet": False},
        ]

        executor = SkillExecutor()
        result = await executor.execute_skill(skill, mechanisms, {})

        assert result.success is True
        assert result.data["cached"] is True
        assert result.mechanism_used == "cache"
        assert len(result.mechanism_log) == 2

    @pytest.mark.anyio
    async def test_execute_first_success_wins(self):
        """Test that first successful mechanism stops the chain."""
        skill = MockSkill(results={
            "api": MechanismResult(success=True, data={"from": "api"}),
            "cache": MechanismResult(success=True, data={"from": "cache"}),
        })
        mechanisms = [
            {"method": "api", "priority": 1, "timeout_ms": 1000, "requires_internet": True},
            {"method": "cache", "priority": 2, "timeout_ms": 500, "requires_internet": False},
        ]

        executor = SkillExecutor()
        result = await executor.execute_skill(skill, mechanisms, {})

        assert result.mechanism_used == "api"
        assert result.data["from"] == "api"
        assert len(result.mechanism_log) == 1  # cache was never tried

    @pytest.mark.anyio
    async def test_execute_all_mechanisms_fail(self):
        """Test graceful failure when all mechanisms fail."""
        skill = MockSkill(results={
            "api": MechanismResult(success=False, error="down"),
            "cache": MechanismResult(success=False, error="miss"),
        })
        mechanisms = [
            {"method": "api", "priority": 1, "timeout_ms": 1000, "requires_internet": True},
            {"method": "cache", "priority": 2, "timeout_ms": 500, "requires_internet": False},
        ]

        executor = SkillExecutor()
        result = await executor.execute_skill(skill, mechanisms, {})

        assert result.success is False
        assert result.mechanism_used is None
        assert len(result.mechanism_log) == 2

    @pytest.mark.anyio
    async def test_execute_mechanism_timeout(self):
        """Test that slow mechanisms are timed out."""
        skill = SlowSkill(
            delay=5.0,  # 5 seconds
            result=MechanismResult(success=True, data={"slow": True}),
        )
        mechanisms = [
            {"method": "slow_api", "priority": 1, "timeout_ms": 100, "requires_internet": True},
        ]

        executor = SkillExecutor()
        result = await executor.execute_skill(skill, mechanisms, {})

        assert result.success is False
        assert result.mechanism_log[0]["status"] == "timed_out"

    @pytest.mark.anyio
    async def test_execute_mechanism_exception_caught(self):
        """Test that exceptions in mechanisms are caught gracefully."""
        skill = MockSkill(results={
            "buggy": RuntimeError("unexpected crash"),
        })
        mechanisms = [
            {"method": "buggy", "priority": 1, "timeout_ms": 1000, "requires_internet": False},
        ]

        executor = SkillExecutor()
        result = await executor.execute_skill(skill, mechanisms, {})

        assert result.success is False
        assert "crash" in result.mechanism_log[0]["error"]

    @pytest.mark.anyio
    async def test_parallel_skill_execution(self):
        """Test executing multiple skills in parallel."""
        skill_a = MockSkill(results={
            "api": MechanismResult(success=True, data={"skill": "A"}),
        })
        skill_b = MockSkill(results={
            "api": MechanismResult(success=True, data={"skill": "B"}),
        })

        executor = SkillExecutor()
        tasks = [
            ("ask_001", skill_a, [{"method": "api", "priority": 1, "timeout_ms": 1000, "requires_internet": False}], {}),
            ("ask_002", skill_b, [{"method": "api", "priority": 1, "timeout_ms": 1000, "requires_internet": False}], {}),
        ]
        results = await executor.execute_parallel(tasks)

        assert len(results) == 2
        assert results["ask_001"].success is True
        assert results["ask_002"].success is True
        assert results["ask_001"].data["skill"] == "A"
        assert results["ask_002"].data["skill"] == "B"

    @pytest.mark.anyio
    async def test_source_metadata_preserved(self):
        """Test that source_metadata from mechanism result is preserved."""
        skill = MockSkill(results={
            "api": MechanismResult(
                success=True,
                data={"info": "test"},
                source_url="https://example.com",
                source_title="Example Page",
            ),
        })
        mechanisms = [
            {"method": "api", "priority": 1, "timeout_ms": 1000, "requires_internet": False},
        ]

        executor = SkillExecutor()
        result = await executor.execute_skill(skill, mechanisms, {})

        assert result.source_url == "https://example.com"
        assert result.source_title == "Example Page"
