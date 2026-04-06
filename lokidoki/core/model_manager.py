from dataclasses import dataclass
from lokidoki.core.inference import InferenceClient


@dataclass
class ModelPolicy:
    """Model switching policy per DESIGN.md Section II."""
    fast_model: str = "gemma4:e2b"
    thinking_model: str = "gemma4:e2b"
    fast_keep_alive: int | str = -1  # resident forever
    thinking_keep_alive: str = "5m"  # free after 5 min inactivity

    def select(self, complexity: str) -> tuple[str, int | str]:
        """Select model and keep_alive based on reasoning complexity."""
        if complexity == "thinking":
            return self.thinking_model, self.thinking_keep_alive
        return self.fast_model, self.fast_keep_alive


class ModelManager:
    """Manages model lifecycle: residency, switching, and availability checks."""

    def __init__(
        self,
        inference_client: InferenceClient,
        policy: ModelPolicy | None = None,
    ):
        self._client = inference_client
        self._policy = policy or ModelPolicy()

    def get_model(self, complexity: str) -> tuple[str, int | str]:
        """Get the appropriate model for a given reasoning complexity."""
        return self._policy.select(complexity)

    async def ensure_resident(self) -> bool:
        """Pre-load the fast model into RAM for minimal cold-start latency.

        Sends a minimal prompt to force Ollama to load the model with keep_alive=-1.
        """
        try:
            await self._client.generate(
                model=self._policy.fast_model,
                prompt=".",
                keep_alive=self._policy.fast_keep_alive,
            )
            return True
        except Exception:
            return False

    async def list_available_models(self) -> list[str]:
        """Query Ollama for available model tags."""
        try:
            response = await self._client._client.get("/api/tags")
            if response.status_code == 200:
                data = response.json()
                return [m["name"] for m in data.get("models", [])]
            return []
        except Exception:
            return []
