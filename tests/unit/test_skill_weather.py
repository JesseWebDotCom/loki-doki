import pytest
import json
from unittest.mock import AsyncMock, patch, MagicMock
from lokidoki.skills.weather_owm.skill import WeatherSkill
from lokidoki.core.skill_executor import MechanismResult


OWM_RESPONSE = {
    "weather": [{"main": "Clear", "description": "clear sky"}],
    "main": {"temp": 22.5, "feels_like": 21.0, "humidity": 45},
    "wind": {"speed": 3.2},
    "name": "Seattle",
}


class TestWeatherSkill:
    @pytest.mark.anyio
    async def test_owm_api_success(self):
        """Test successful OWM API call."""
        skill = WeatherSkill(api_key="test_key")
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = OWM_RESPONSE

        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=mock_response):
            result = await skill.execute_mechanism("owm_api", {"location": "Seattle"})

        assert result.success is True
        assert result.data["location"] == "Seattle"
        assert result.data["temperature"] == 22.5
        assert result.data["condition"] == "clear sky"
        assert result.data["humidity"] == 45
        assert result.source_url != ""

    @pytest.mark.anyio
    async def test_owm_api_missing_location(self):
        """Test that missing location parameter fails gracefully."""
        skill = WeatherSkill(api_key="test_key")
        result = await skill.execute_mechanism("owm_api", {})

        assert result.success is False
        assert "location" in result.error.lower()

    @pytest.mark.anyio
    async def test_owm_api_http_error(self):
        """Test handling of HTTP errors from OWM."""
        skill = WeatherSkill(api_key="test_key")
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"

        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=mock_response):
            result = await skill.execute_mechanism("owm_api", {"location": "Seattle"})

        assert result.success is False
        assert "401" in result.error

    @pytest.mark.anyio
    async def test_local_cache_miss(self):
        """Test cache mechanism returns miss when empty."""
        skill = WeatherSkill(api_key="test_key")
        result = await skill.execute_mechanism("local_cache", {"location": "Seattle"})

        assert result.success is False
        assert "cache miss" in result.error.lower()

    @pytest.mark.anyio
    async def test_local_cache_hit(self):
        """Test cache mechanism returns data when populated."""
        skill = WeatherSkill(api_key="test_key")
        # Populate the cache via a successful API call
        skill._cache["seattle"] = {
            "location": "Seattle", "temperature": 22.5,
            "condition": "clear sky", "humidity": 45,
            "wind_speed": 3.2, "feels_like": 21.0,
        }

        result = await skill.execute_mechanism("local_cache", {"location": "Seattle"})
        assert result.success is True
        assert result.data["temperature"] == 22.5

    @pytest.mark.anyio
    async def test_owm_api_caches_result(self):
        """Test that successful API calls populate the cache."""
        skill = WeatherSkill(api_key="test_key")
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = OWM_RESPONSE

        with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=mock_response):
            await skill.execute_mechanism("owm_api", {"location": "Seattle"})

        assert "seattle" in skill._cache

    @pytest.mark.anyio
    async def test_unknown_mechanism(self):
        """Test that unknown mechanisms raise ValueError."""
        skill = WeatherSkill(api_key="test_key")
        with pytest.raises(ValueError, match="Unknown mechanism"):
            await skill.execute_mechanism("unknown", {})
