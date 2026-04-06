import pytest
import json
import os
import tempfile
from lokidoki.skills.smarthome_mock.skill import SmartHomeMockSkill


@pytest.fixture
def skill(tmp_path):
    state_path = str(tmp_path / "smarthome.json")
    return SmartHomeMockSkill(state_path=state_path)


class TestSmartHomeMockSkill:
    @pytest.mark.anyio
    async def test_get_device_status(self, skill):
        result = await skill.execute_mechanism("local_state", {"device": "reading lamp"})
        assert result.success
        assert result.data["name"] == "Reading Lamp"
        assert result.data["state"] == "on"

    @pytest.mark.anyio
    async def test_turn_device_on(self, skill):
        result = await skill.execute_mechanism("local_state", {"device": "living room light", "action": "on"})
        assert result.success
        assert result.data["state"] == "on"

    @pytest.mark.anyio
    async def test_turn_device_off(self, skill):
        result = await skill.execute_mechanism("local_state", {"device": "reading lamp", "action": "off"})
        assert result.success
        assert result.data["state"] == "off"

    @pytest.mark.anyio
    async def test_toggle_device(self, skill):
        result = await skill.execute_mechanism("local_state", {"device": "reading lamp", "action": "toggle"})
        assert result.success
        assert result.data["state"] == "off"  # Was on, now off

    @pytest.mark.anyio
    async def test_lock_door(self, skill):
        # First unlock
        await skill.execute_mechanism("local_state", {"device": "front door", "action": "unlock"})
        result = await skill.execute_mechanism("local_state", {"device": "front door", "action": "status"})
        assert result.data["state"] == "unlocked"

        # Then lock
        result = await skill.execute_mechanism("local_state", {"device": "front door", "action": "lock"})
        assert result.data["state"] == "locked"

    @pytest.mark.anyio
    async def test_set_brightness(self, skill):
        result = await skill.execute_mechanism("local_state", {"device": "reading lamp", "action": "brightness:40"})
        assert result.success
        assert result.data["brightness"] == 40

    @pytest.mark.anyio
    async def test_set_temperature(self, skill):
        result = await skill.execute_mechanism("local_state", {"device": "thermostat", "action": "temp:24.5"})
        assert result.success
        assert result.data["temperature"] == 24.5

    @pytest.mark.anyio
    async def test_device_not_found(self, skill):
        result = await skill.execute_mechanism("local_state", {"device": "nonexistent device xyz"})
        assert not result.success
        assert "not found" in result.error.lower()

    @pytest.mark.anyio
    async def test_unknown_action(self, skill):
        result = await skill.execute_mechanism("local_state", {"device": "reading lamp", "action": "explode"})
        assert not result.success
        assert "Unknown action" in result.error

    @pytest.mark.anyio
    async def test_state_persists_to_file(self, skill):
        await skill.execute_mechanism("local_state", {"device": "reading lamp", "action": "off"})
        assert os.path.exists(skill._state_path)

        with open(skill._state_path) as f:
            state = json.load(f)
        assert state["reading_lamp"]["state"] == "off"

    @pytest.mark.anyio
    async def test_fuzzy_match_by_name(self, skill):
        result = await skill.execute_mechanism("local_state", {"device": "bedroom"})
        assert result.success
        assert result.data["name"] == "Bedroom Light"

    @pytest.mark.anyio
    async def test_unknown_mechanism_raises(self, skill):
        with pytest.raises(ValueError, match="Unknown mechanism"):
            await skill.execute_mechanism("ha_api", {"device": "test"})
