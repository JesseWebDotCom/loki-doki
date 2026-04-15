"""Shape guarantees for :class:`ProviderSpec` — frozen + field set stable."""
from __future__ import annotations

import dataclasses

import pytest

from lokidoki.core.providers.spec import ProviderSpec


def _spec() -> ProviderSpec:
    return ProviderSpec(
        name="mlx",
        endpoint="http://127.0.0.1:11434",
        model_fast="mlx-community/Qwen3-8B-4bit",
        model_thinking="mlx-community/Qwen3-14B-4bit",
    )


def test_frozen_blocks_mutation() -> None:
    spec = _spec()
    with pytest.raises(dataclasses.FrozenInstanceError):
        spec.endpoint = "http://evil.example"  # type: ignore[misc]


def test_required_fields_present() -> None:
    fields = {f.name for f in dataclasses.fields(ProviderSpec)}
    assert fields == {
        "name",
        "endpoint",
        "model_fast",
        "model_thinking",
        "api_style",
        "vision_model",
        "vision_endpoint",
    }


def test_default_api_style_openai_compat() -> None:
    assert _spec().api_style == "openai_compat"


def test_model_for_picks_thinking_on_match() -> None:
    spec = _spec()
    assert spec.model_for("fast") == spec.model_fast
    assert spec.model_for("simple") == spec.model_fast
    assert spec.model_for("thinking") == spec.model_thinking


def test_equal_specs_compare_equal() -> None:
    assert _spec() == _spec()
