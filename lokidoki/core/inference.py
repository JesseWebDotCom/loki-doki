import httpx


class OllamaError(Exception):
    """Raised when Ollama API returns an error or is unreachable."""
    pass


class InferenceClient:
    """Async wrapper for the Ollama HTTP API."""

    def __init__(self, base_url: str = "http://localhost:11434"):
        self.base_url = base_url
        self._client = httpx.AsyncClient(base_url=base_url, timeout=120.0)

    async def generate(
        self,
        model: str,
        prompt: str,
        keep_alive: int | str = -1,
        json_mode: bool = False,
        num_predict: int | None = None,
        format_schema: dict | None = None,
        temperature: float | None = None,
    ) -> str:
        """Send a prompt to Ollama and return the response text.

        Args:
            model: Ollama model tag (e.g. "gemma4:e2b").
            prompt: The prompt string.
            keep_alive: How long to keep model in memory (-1 = forever).
            json_mode: If True, request loose JSON output (legacy / freeform).
            num_predict: Hard cap on output tokens (safety net).
            format_schema: JSON Schema dict for structured output. When set,
                Ollama constrains decoding to the schema and terminates as soon
                as it is satisfied — preventing trailing-whitespace runaway.
            temperature: Sampling temperature override (0 for deterministic).
        """
        payload = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "keep_alive": keep_alive,
        }
        if format_schema is not None:
            payload["format"] = format_schema
        elif json_mode:
            payload["format"] = "json"
        options: dict = {}
        if num_predict is not None:
            options["num_predict"] = num_predict
        if temperature is not None:
            options["temperature"] = temperature
        if options:
            payload["options"] = options

        try:
            response = await self._client.post("/api/generate", json=payload)
        except (httpx.ConnectError, ConnectionError, OSError):
            raise OllamaError(f"Ollama unreachable at {self.base_url}")
        except Exception as e:
            raise OllamaError(f"Ollama request failed: {e}")

        if response.status_code == 404:
            raise OllamaError(
                f"Model '{model}' not found. Pull it with: ollama pull {model}"
            )
        if response.status_code != 200:
            raise OllamaError(
                f"Ollama error {response.status_code}: {response.text[:200]}"
            )

        return response.json()["response"]

    async def close(self):
        await self._client.aclose()
