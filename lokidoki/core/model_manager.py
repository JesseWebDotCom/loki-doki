from dataclasses import dataclass
from lokidoki.core.inference import InferenceClient
from lokidoki.core.platform import detect_platform, get_model_preset


@dataclass
class ModelPolicy:
    """Model switching policy per DESIGN.md Section II.

    Defaults are set from platform detection at construction time.
    """
    fast_model: str = ""
    thinking_model: str = ""
    fast_keep_alive: int | str = -1
    thinking_keep_alive: str = "5m"
    platform: str = ""

    def __post_init__(self):
        if not self.platform:
            self.platform = detect_platform()
        if not self.fast_model or not self.thinking_model:
            preset = get_model_preset(self.platform)
            self.fast_model = self.fast_model or preset["fast_model"]
            self.thinking_model = self.thinking_model or preset["thinking_model"]
            self.fast_keep_alive = preset["fast_keep_alive"]
            self.thinking_keep_alive = preset["thinking_keep_alive"]

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

    @property
    def policy(self) -> ModelPolicy:
        return self._policy

    def get_model(self, complexity: str) -> tuple[str, int | str]:
        """Get the appropriate model for a given reasoning complexity."""
        return self._policy.select(complexity)

    async def ensure_resident(self) -> bool:
        """Pre-load the fast model into RAM for minimal cold-start latency."""
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
