"""``resolve_llm_provider`` must follow ``PLATFORM_MODELS`` exactly."""
from __future__ import annotations

import pytest

from lokidoki.core.platform import PLATFORM_MODELS
from lokidoki.core.providers.registry import resolve_llm_provider


@pytest.mark.parametrize("profile", list(PLATFORM_MODELS.keys()))
def test_every_profile_resolves(profile: str) -> None:
    spec = resolve_llm_provider(profile)
    assert spec.name == PLATFORM_MODELS[profile]["llm_engine"]
    assert spec.model_fast == PLATFORM_MODELS[profile]["llm_fast"]
    assert spec.model_thinking == PLATFORM_MODELS[profile]["llm_thinking"]


def test_mac_resolves_to_mlx_on_11434() -> None:
    spec = resolve_llm_provider("mac")
    assert spec.name == "mlx"
    assert spec.endpoint == "http://127.0.0.1:11434"
    assert spec.api_style == "openai_compat"


def test_pi_hailo_resolves_to_hailo_ollama() -> None:
    spec = resolve_llm_provider("pi_hailo")
    assert spec.name == "hailo_ollama"
    # Single loopback port simplifies Layer 2 — the wizard picks which
    # engine is live, the client just speaks OpenAI-compat.
    assert spec.endpoint == "http://127.0.0.1:11434"


def test_unknown_profile_raises() -> None:
    with pytest.raises(KeyError):
        resolve_llm_provider("solaris")
