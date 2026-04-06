import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from lokidoki.core.inference import InferenceClient, OllamaError


@pytest.fixture
def client():
    return InferenceClient(base_url="http://localhost:11434")


class TestInferenceClient:
    @pytest.mark.anyio
    async def test_generate_returns_parsed_response(self, client):
        """Test that generate() calls Ollama and returns the response text."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": "Hello world", "done": True}
        mock_response.raise_for_status = MagicMock()

        with patch.object(client._client, "post", new_callable=AsyncMock, return_value=mock_response):
            result = await client.generate("gemma4:e2b", "Say hello")

        assert result == "Hello world"

    @pytest.mark.anyio
    async def test_generate_passes_model_and_prompt(self, client):
        """Test that the correct model and prompt are sent to Ollama."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": "ok", "done": True}
        mock_response.raise_for_status = MagicMock()

        with patch.object(client._client, "post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.generate("gemma4:e2b", "test prompt", keep_alive="5m")

        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args
        payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
        assert payload["model"] == "gemma4:e2b"
        assert payload["prompt"] == "test prompt"
        assert payload["keep_alive"] == "5m"
        assert payload["stream"] is False

    @pytest.mark.anyio
    async def test_generate_forwards_num_predict_option(self, client):
        """Regression: num_predict must be forwarded to Ollama via options.num_predict
        so callers can cap output length and avoid runaway generation."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": "{}", "done": True}
        mock_response.raise_for_status = MagicMock()

        with patch.object(client._client, "post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.generate("gemma4:e2b", "p", num_predict=128)

        payload = mock_post.call_args.kwargs["json"]
        assert payload.get("options", {}).get("num_predict") == 128

    @pytest.mark.anyio
    async def test_generate_forwards_format_schema(self, client):
        """Regression: format_schema must be sent to Ollama as the `format` field
        (structured output). This is the real fix for the gemma JSON-mode runaway —
        the schema constrains decoding so the model terminates cleanly."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": "{}", "done": True}
        mock_response.raise_for_status = MagicMock()

        schema = {"type": "object", "properties": {"x": {"type": "string"}}}
        with patch.object(client._client, "post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.generate("gemma4:e2b", "p", format_schema=schema, temperature=0.0)

        payload = mock_post.call_args.kwargs["json"]
        assert payload["format"] == schema, "format_schema must be sent as Ollama 'format'"
        assert payload.get("options", {}).get("temperature") == 0.0

    @pytest.mark.anyio
    async def test_generate_format_schema_overrides_json_mode(self, client):
        """When both are set, schema wins — json_mode is the legacy fallback."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": "{}", "done": True}
        mock_response.raise_for_status = MagicMock()

        schema = {"type": "object"}
        with patch.object(client._client, "post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.generate("gemma4:e2b", "p", json_mode=True, format_schema=schema)

        payload = mock_post.call_args.kwargs["json"]
        assert payload["format"] == schema

    @pytest.mark.anyio
    async def test_generate_stream_yields_response_chunks(self, client):
        """generate_stream must yield each response token as it arrives from
        the NDJSON stream and stop on the `done` chunk."""
        ndjson_lines = [
            '{"response":"Hello"}',
            '{"response":" world"}',
            '{"response":"!","done":true}',
        ]

        class FakeStream:
            def __init__(self):
                self.status_code = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

            async def aiter_lines(self):
                for line in ndjson_lines:
                    yield line

            async def aread(self):
                return b""

        with patch.object(client._client, "stream", return_value=FakeStream()) as mock_stream:
            chunks = [c async for c in client.generate_stream("gemma4:e2b", "hi", num_predict=64)]

        assert chunks == ["Hello", " world", "!"]
        payload = mock_stream.call_args.kwargs["json"]
        assert payload["stream"] is True
        assert payload["options"]["num_predict"] == 64

    @pytest.mark.anyio
    async def test_generate_raises_on_http_error(self, client):
        """Test that OllamaError is raised on non-200 responses."""
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal Server Error"
        mock_response.raise_for_status.side_effect = Exception("HTTP 500")

        with patch.object(client._client, "post", new_callable=AsyncMock, return_value=mock_response):
            with pytest.raises(OllamaError):
                await client.generate("gemma4:e2b", "test")

    @pytest.mark.anyio
    async def test_generate_raises_on_connection_error(self, client):
        """Test that OllamaError is raised when Ollama is unreachable."""
        with patch.object(client._client, "post", new_callable=AsyncMock, side_effect=ConnectionError("refused")):
            with pytest.raises(OllamaError, match="unreachable"):
                await client.generate("gemma4:e2b", "test")

    @pytest.mark.anyio
    async def test_generate_json_mode(self, client):
        """Test that format='json' is passed when json_mode=True."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": '{"key": "value"}', "done": True}
        mock_response.raise_for_status = MagicMock()

        with patch.object(client._client, "post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            result = await client.generate("gemma4:e2b", "return json", json_mode=True)

        payload = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
        assert payload["format"] == "json"
        assert result == '{"key": "value"}'

    @pytest.mark.anyio
    async def test_default_keep_alive(self, client):
        """Test that default keep_alive is -1 (resident)."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": "ok", "done": True}
        mock_response.raise_for_status = MagicMock()

        with patch.object(client._client, "post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.generate("gemma4:e2b", "test")

        payload = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
        assert payload["keep_alive"] == -1
