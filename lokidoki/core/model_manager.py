"""Model policy and lifecycle management.

``ModelPolicy`` selects fast / thinking models per profile.
``ModelManager`` handles residency warm-up and model listing via the
OpenAI-compatible ``/v1/`` API that all shipped engines expose.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Union, Tuple, List

from lokidoki.core.providers.client import HTTPProvider
from lokidoki.core.platform import (
    PLATFORM_MODELS,
    detect_profile,
    get_model_preset,
)


@dataclass
class ModelPolicy:
    """Model switching policy per DESIGN.md Section II.

    Defaults are set from profile detection at construction time.
    """
    fast_model: str = ""
    thinking_model: str = ""
    fast_keep_alive: Union[int, str] = -1
    thinking_keep_alive: str = "5m"
    profile: str = ""

    def __post_init__(self):
        if not self.profile:
            self.profile = detect_profile()
        if not self.fast_model or not self.thinking_model:
            preset = get_model_preset(self.profile)
            self.fast_model = self.fast_model or preset["llm_fast"]
            self.thinking_model = self.thinking_model or preset["llm_thinking"]
            self.fast_keep_alive = preset["fast_keep_alive"]
            self.thinking_keep_alive = preset["thinking_keep_alive"]

    @property
    def engine(self) -> str:
        """Return the LLM engine for this profile (e.g. 'mlx', 'llama_cpp_vulkan')."""
        return PLATFORM_MODELS[self.profile]["llm_engine"]

    def select(self, complexity: str) -> Tuple[str, Union[int, str]]:
        """Select model and keep_alive based on reasoning complexity."""
        if complexity == "thinking":
            return self.thinking_model, self.thinking_keep_alive
        return self.fast_model, self.fast_keep_alive


class ModelManager:
    """Manages model lifecycle: residency warm-up and availability checks.

    Uses :class:`HTTPProvider` which speaks the OpenAI-compatible
    ``/v1/chat/completions`` and ``/v1/models`` endpoints supported by
    all shipped engines (mlx-lm, llama-server, hailo-ollama).
    """

    def __init__(
        self,
        provider: HTTPProvider,
        policy: Optional[ModelPolicy] = None,
    ):
        self._provider = provider
        self._policy = policy or ModelPolicy()

    @property
    def policy(self) -> ModelPolicy:
        return self._policy

    def get_model(self, complexity: str) -> Tuple[str, Union[int, str]]:
        """Get the appropriate model for a given reasoning complexity."""
        return self._policy.select(complexity)

    async def ensure_resident(self) -> bool:
        """Pre-load the fast model into RAM by sending a minimal prompt."""
        try:
            await self._provider.generate(
                model=self._policy.fast_model,
                prompt=".",
                max_tokens=1,
            )
            return True
        except Exception:
            return False

    async def list_available_models(self) -> list[str]:
        """Query the engine for available models via ``/v1/models``."""
        try:
            response = await self._provider._client.get("/v1/models")
            if response.status_code == 200:
                data = response.json()
                return [m["id"] for m in data.get("data", [])]
            return []
        except Exception:
            return []

    async def enforce_residency(self) -> dict[str, List[str]]:
        """Return which configured models are available.

        Unlike the old Ollama-based implementation, OpenAI-compat
        engines (mlx-lm, llama-server) do not support per-model
        keep_alive / unload. We simply report which models the engine
        knows about.
        """
        from lokidoki.orchestrator.core.config import CONFIG

        authorized = {
            self._policy.fast_model,
            self._policy.thinking_model,
            CONFIG.llm_model,
        }
        authorized = {m for m in authorized if m}

        results: dict[str, List[str]] = {"kept": [], "unloaded": []}

        try:
            available = await self.list_available_models()
            for model_id in available:
                is_auth = any(
                    model_id == auth or model_id.startswith(auth + ":")
                    or auth.startswith(model_id + ":")
                    for auth in authorized
                )
                if is_auth:
                    results["kept"].append(model_id)
                # No unload action — OpenAI-compat engines don't support it
            return results
        except Exception:
            return results
