import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from lokidoki.core.model_manager import ModelManager, ModelPolicy


class TestModelPolicy:
    def test_auto_detects_platform(self):
        policy = ModelPolicy()
        assert policy.platform in ("mac", "linux", "pi5", "pi")

    def test_pi5_selects_9b_for_thinking(self):
        policy = ModelPolicy(platform="pi5")
        model, keep_alive = policy.select("thinking")
        assert model == "qwen3:4b"
        assert keep_alive == "5m"

    def test_pi5_selects_2b_for_fast(self):
        policy = ModelPolicy(platform="pi5")
        model, keep_alive = policy.select("fast")
        assert model == "qwen3:4b-instruct-2507-q4_K_M"
        assert keep_alive == -1

    def test_pi4_uses_2b_for_thinking(self):
        policy = ModelPolicy(platform="pi")
        model, _ = policy.select("thinking")
        assert model == "qwen3:4b-instruct-2507-q4_K_M"  # Pi 4 avoids reasoning variants

    def test_mac_selects_9b_for_thinking(self):
        policy = ModelPolicy(platform="mac")
        model, _ = policy.select("thinking")
        assert model == "qwen3:4b"

    def test_unknown_complexity_defaults_to_fast(self):
        policy = ModelPolicy(platform="mac")
        model, keep_alive = policy.select("unknown")
        assert model == "qwen3:4b-instruct-2507-q4_K_M"
        assert keep_alive == -1

    def test_custom_models_override_preset(self):
        policy = ModelPolicy(
            fast_model="custom:2b",
            thinking_model="custom:9b",
            platform="mac",
        )
        model, _ = policy.select("thinking")
        assert model == "custom:9b"
        model, _ = policy.select("fast")
        assert model == "custom:2b"


class TestModelManager:
    @pytest.mark.anyio
    async def test_ensure_resident_loads_fast_model(self):
        mock_client = AsyncMock()
        mock_client.generate = AsyncMock(return_value="ok")
        policy = ModelPolicy(platform="pi5")

        manager = ModelManager(inference_client=mock_client, policy=policy)
        result = await manager.ensure_resident()

        assert result is True
        call_kwargs = mock_client.generate.call_args.kwargs
        assert call_kwargs["model"] == "qwen3:4b-instruct-2507-q4_K_M"
        assert call_kwargs["keep_alive"] == -1

    @pytest.mark.anyio
    async def test_ensure_resident_handles_error(self):
        mock_client = AsyncMock()
        mock_client.generate = AsyncMock(side_effect=Exception("unreachable"))

        manager = ModelManager(inference_client=mock_client)
        result = await manager.ensure_resident()
        assert result is False

    @pytest.mark.anyio
    async def test_check_model_availability(self):
        mock_client = AsyncMock()
        mock_client._client = MagicMock()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "models": [
                {"name": "qwen3:4b-instruct-2507-q4_K_M"},
                {"name": "qwen3:4b"},
            ]
        }
        mock_client._client.get = AsyncMock(return_value=mock_response)

        manager = ModelManager(inference_client=mock_client)
        models = await manager.list_available_models()

        assert "qwen3:4b-instruct-2507-q4_K_M" in models
        assert "qwen3:4b" in models

    @pytest.mark.anyio
    async def test_get_model_for_thinking_on_pi5(self):
        mock_client = AsyncMock()
        policy = ModelPolicy(platform="pi5")
        manager = ModelManager(inference_client=mock_client, policy=policy)

        model, keep_alive = manager.get_model("thinking")
        assert model == "qwen3:4b"
        assert keep_alive == "5m"

    @pytest.mark.anyio
    async def test_get_model_for_fast(self):
        mock_client = AsyncMock()
        manager = ModelManager(inference_client=mock_client)

        model, keep_alive = manager.get_model("fast")
        assert model == "qwen3:4b-instruct-2507-q4_K_M"

    def test_policy_property(self):
        mock_client = AsyncMock()
        policy = ModelPolicy(platform="mac")
        manager = ModelManager(inference_client=mock_client, policy=policy)
        assert manager.policy.platform == "mac"
