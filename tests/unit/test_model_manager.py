import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from lokidoki.core.model_manager import ModelManager, ModelPolicy


class TestModelPolicy:
    def test_fast_model_default(self):
        policy = ModelPolicy()
        assert policy.fast_model == "gemma4:e2b"
        assert policy.thinking_model == "gemma4:e2b"

    def test_select_model_for_fast(self):
        policy = ModelPolicy()
        model, keep_alive = policy.select("fast")
        assert model == "gemma4:e2b"
        assert keep_alive == -1  # resident

    def test_select_model_for_thinking(self):
        policy = ModelPolicy()
        model, keep_alive = policy.select("thinking")
        assert model == "gemma4:e2b"
        assert keep_alive == "5m"  # dynamic load

    def test_select_model_unknown_defaults_to_fast(self):
        policy = ModelPolicy()
        model, keep_alive = policy.select("unknown")
        assert model == "gemma4:e2b"

    def test_custom_models(self):
        policy = ModelPolicy(fast_model="custom:2b", thinking_model="custom:9b")
        model, _ = policy.select("thinking")
        assert model == "custom:9b"


class TestModelManager:
    @pytest.mark.anyio
    async def test_ensure_resident_loads_fast_model(self):
        """Test that ensure_resident pre-loads the fast model."""
        mock_client = AsyncMock()
        mock_client.generate = AsyncMock(return_value="ok")

        manager = ModelManager(inference_client=mock_client)
        await manager.ensure_resident()

        mock_client.generate.assert_called_once()
        call_kwargs = mock_client.generate.call_args.kwargs
        assert call_kwargs["model"] == "gemma4:e2b"
        assert call_kwargs["keep_alive"] == -1

    @pytest.mark.anyio
    async def test_ensure_resident_handles_error(self):
        """Test graceful handling when Ollama is unavailable."""
        mock_client = AsyncMock()
        mock_client.generate = AsyncMock(side_effect=Exception("unreachable"))

        manager = ModelManager(inference_client=mock_client)
        # Should not raise
        result = await manager.ensure_resident()
        assert result is False

    @pytest.mark.anyio
    async def test_check_model_availability(self):
        """Test checking if a model is available in Ollama."""
        mock_client = AsyncMock()
        mock_client._client = MagicMock()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "models": [
                {"name": "gemma4:e2b"},
                {"name": "gemma4:e2b"},
            ]
        }
        mock_client._client.get = AsyncMock(return_value=mock_response)

        manager = ModelManager(inference_client=mock_client)
        models = await manager.list_available_models()

        assert "gemma4:e2b" in models
        assert "gemma4:e2b" in models

    @pytest.mark.anyio
    async def test_get_model_for_complexity(self):
        """Test model selection based on reasoning complexity."""
        mock_client = AsyncMock()
        manager = ModelManager(inference_client=mock_client)

        model, keep_alive = manager.get_model("fast")
        assert model == "gemma4:e2b"

        model, keep_alive = manager.get_model("thinking")
        assert model == "gemma4:e2b"
        assert keep_alive == "5m"
