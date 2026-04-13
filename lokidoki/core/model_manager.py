from dataclasses import dataclass
from typing import Optional, Union, Tuple, List
from lokidoki.core.inference import InferenceClient
from lokidoki.core.platform import detect_platform, get_model_preset


@dataclass
class ModelPolicy:
    """Model switching policy per DESIGN.md Section II.

    Defaults are set from platform detection at construction time.
    """
    fast_model: str = ""
    thinking_model: str = ""
    fast_keep_alive: Union[int, str] = -1
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

    def select(self, complexity: str) -> Tuple[str, Union[int, str]]:
        """Select model and keep_alive based on reasoning complexity."""
        if complexity == "thinking":
            return self.thinking_model, self.thinking_keep_alive
        return self.fast_model, self.fast_keep_alive


class ModelManager:
    """Manages model lifecycle: residency, switching, and availability checks."""

    def __init__(
        self,
        inference_client: InferenceClient,
        policy: Optional[ModelPolicy] = None,
    ):
        self._client = inference_client
        self._policy = policy or ModelPolicy()

    @property
    def policy(self) -> ModelPolicy:
        return self._policy

    def get_model(self, complexity: str) -> Tuple[str, Union[int, str]]:
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

    async def enforce_residency(self) -> dict[str, List[str]]:
        """Ensure ONLY configured models are in RAM; unload all others.
        
        Returns a dict with 'kept' and 'unloaded' model lists.
        """
        from lokidoki.orchestrator.core.config import CONFIG
        
        # 1. Identify authorized models
        authorized = {
            self._policy.fast_model,
            self._policy.thinking_model,
            CONFIG.llm_model,
        }
        # Strip potential duplicates/empty strings
        authorized = {m for m in authorized if m}

        results = {"kept": [], "unloaded": []}
        
        try:
            # 2. Query currently loaded models
            response = await self._client._client.get("/api/ps")
            if response.status_code != 200:
                return results
            
            loaded = response.json().get("models", [])
            for model_info in loaded:
                name = model_info.get("name")
                if not name:
                    continue
                
                # Check if this model (or its base tag) is authorized
                # (Ollama often returns full tags like 'qwen3:4b-instruct-2507-q4_K_M')
                is_auth = any(
                    name == auth or name.startswith(auth + ":") or auth.startswith(name + ":")
                    for auth in authorized
                )
                
                if is_auth:
                    results["kept"].append(name)
                else:
                    # 3. Unload Unauthorized Model
                    # We do this by sending a dummy generate with keep_alive: 0
                    await self._client._client.post(
                        "/api/generate",
                        json={"model": name, "prompt": ".", "keep_alive": 0, "stream": False}
                    )
                    results["unloaded"].append(name)
                    
            return results
        except Exception:
            return results
