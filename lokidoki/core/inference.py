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
    ) -> str:
        """Send a prompt to Ollama and return the response text.

        Args:
            model: Ollama model tag (e.g. "gemma4:e2b").
            prompt: The prompt string.
            keep_alive: How long to keep model in memory (-1 = forever).
            json_mode: If True, request JSON-formatted output.
        """
        payload = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "keep_alive": keep_alive,
        }
        if json_mode:
            payload["format"] = "json"

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
