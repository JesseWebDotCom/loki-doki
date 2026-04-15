import pytest
from unittest.mock import AsyncMock, MagicMock
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.platform import PLATFORM_MODELS


VALID_PROFILES = {"mac", "windows", "linux", "pi_cpu", "pi_hailo"}


class TestModelPolicy:
    def test_auto_detects_profile(self):
        policy = ModelPolicy()
        assert policy.profile in VALID_PROFILES

    def test_pi_cpu_thinking_uses_qwen3_4b(self):
        policy = ModelPolicy(profile="pi_cpu")
        model, keep_alive = policy.select("thinking")
        assert model == PLATFORM_MODELS["pi_cpu"]["llm_thinking"]
        assert keep_alive == "5m"

    def test_pi_cpu_fast_uses_qwen3_4b_instruct(self):
        policy = ModelPolicy(profile="pi_cpu")
        model, keep_alive = policy.select("fast")
        assert model == PLATFORM_MODELS["pi_cpu"]["llm_fast"]
        assert keep_alive == -1

    def test_pi_hailo_uses_hailo_ollama_tags(self):
        policy = ModelPolicy(profile="pi_hailo")
        assert policy.fast_model == "qwen3:1.7b"
        assert policy.thinking_model == "qwen3:4b"

    def test_mac_thinking_uses_mlx_14b(self):
        policy = ModelPolicy(profile="mac")
        model, _ = policy.select("thinking")
        assert model == "mlx-community/Qwen3-14B-4bit"

    def test_unknown_complexity_defaults_to_fast(self):
        policy = ModelPolicy(profile="mac")
        model, keep_alive = policy.select("unknown")
        assert model == "mlx-community/Qwen3-8B-4bit"
        assert keep_alive == -1

    def test_custom_models_override_preset(self):
        policy = ModelPolicy(
            fast_model="custom:fast",
            thinking_model="custom:thinking",
            profile="mac",
        )
        model, _ = policy.select("thinking")
        assert model == "custom:thinking"
        model, _ = policy.select("fast")
        assert model == "custom:fast"

    def test_engine_property_matches_catalog(self):
        for profile in VALID_PROFILES:
            policy = ModelPolicy(profile=profile)
            assert policy.engine == PLATFORM_MODELS[profile]["llm_engine"]


class TestModelManager:
    @pytest.mark.anyio
    async def test_ensure_resident_loads_fast_model(self):
        mock_client = AsyncMock()
        mock_client.generate = AsyncMock(return_value="ok")
        policy = ModelPolicy(profile="pi_cpu")

        manager = ModelManager(inference_client=mock_client, policy=policy)
        result = await manager.ensure_resident()

        assert result is True
        call_kwargs = mock_client.generate.call_args.kwargs
        assert call_kwargs["model"] == PLATFORM_MODELS["pi_cpu"]["llm_fast"]
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
                {"name": "qwen3:4b-instruct"},
                {"name": "qwen3:4b"},
            ]
        }
        mock_client._client.get = AsyncMock(return_value=mock_response)

        manager = ModelManager(inference_client=mock_client)
        models = await manager.list_available_models()

        assert "qwen3:4b-instruct" in models
        assert "qwen3:4b" in models

    @pytest.mark.anyio
    async def test_get_model_for_thinking_on_pi_cpu(self):
        mock_client = AsyncMock()
        policy = ModelPolicy(profile="pi_cpu")
        manager = ModelManager(inference_client=mock_client, policy=policy)

        model, keep_alive = manager.get_model("thinking")
        assert model == PLATFORM_MODELS["pi_cpu"]["llm_thinking"]
        assert keep_alive == "5m"

    @pytest.mark.anyio
    async def test_get_model_for_fast(self):
        mock_client = AsyncMock()
        policy = ModelPolicy(profile="mac")
        manager = ModelManager(inference_client=mock_client, policy=policy)

        model, _ = manager.get_model("fast")
        assert model == "mlx-community/Qwen3-8B-4bit"

    def test_policy_property(self):
        mock_client = AsyncMock()
        policy = ModelPolicy(profile="mac")
        manager = ModelManager(inference_client=mock_client, policy=policy)
        assert manager.policy.profile == "mac"
