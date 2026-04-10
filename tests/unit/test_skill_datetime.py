import pytest
from lokidoki.skills.datetime_local.skill import DateTimeSkill
from lokidoki.core.skill_executor import MechanismResult


class TestDateTimeSkill:
    @pytest.mark.anyio
    async def test_system_clock_returns_datetime(self):
        """Test that system_clock mechanism returns current datetime."""
        skill = DateTimeSkill()
        result = await skill.execute_mechanism("system_clock", {})

        assert result.success is True
        assert "datetime" in result.data
        assert "date" in result.data
        assert "time" in result.data
        assert "timezone" in result.data
        assert "day_of_week" in result.data
        assert "lead" in result.data

    @pytest.mark.anyio
    async def test_system_clock_with_timezone(self):
        """Test datetime with explicit timezone parameter."""
        skill = DateTimeSkill()
        result = await skill.execute_mechanism("system_clock", {"timezone": "UTC"})

        assert result.success is True
        assert "UTC" in result.data["timezone"]

    @pytest.mark.anyio
    async def test_unknown_mechanism_fails(self):
        """Test that unknown mechanisms raise an error."""
        skill = DateTimeSkill()
        with pytest.raises(ValueError, match="Unknown mechanism"):
            await skill.execute_mechanism("unknown_method", {})

    @pytest.mark.anyio
    async def test_invalid_timezone_falls_back(self):
        """Test that an invalid timezone falls back to local time."""
        skill = DateTimeSkill()
        result = await skill.execute_mechanism("system_clock", {"timezone": "Invalid/Zone"})

        # Should still succeed with local time
        assert result.success is True
        assert "datetime" in result.data
