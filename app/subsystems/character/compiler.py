"""Prompt-layer compilation and optimization logic."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Iterable

from app.providers.types import ProviderSpec
from app.subsystems.character import utils
from app.subsystems.character.models import (
    PROMPT_LAYER_ORDER,
    PROMPT_COMPILER_VERSION,
    PROMPT_COMPILER_OPTIONS,
    PROMPT_STAGE_GROUPS,
    PROFANITY_PATTERN,
)


def get_prompt_hash(non_empty_layers: dict[str, str]) -> str:
    """Return the stable hash for one active prompt-layer stack."""
    return hashlib.sha256(
        "\n".join(
            f"{key}:{non_empty_layers[key]}"
            for key in PROMPT_LAYER_ORDER
            if key in non_empty_layers
        ).encode("utf-8")
        + f"\ncompiler:{PROMPT_COMPILER_VERSION}".encode("utf-8")
    ).hexdigest()


def get_prompt_compiler_messages(non_empty_layers: dict[str, str]) -> list[dict[str, str]]:
    """Return the exact compiler system prompt and user input."""
    return [
        {
            "role": "system",
            "content": (
                "You are a prompt compiler. Apply prompt layers in strict priority order. "
                "Each lower-priority layer may operate only within the space allowed by higher-priority layers. "
                "A lower-priority layer cannot weaken, override, reframe, reset, or contradict a higher-priority layer. "
                "Output only the final compiled prompt as a single coherent paragraph."
            ),
        },
        {
            "role": "user",
            "content": _prompt_compiler_input(non_empty_layers),
        },
    ]


def _prompt_compiler_input(non_empty_layers: dict[str, str]) -> str:
    """Return the ordered source text sent to the prompt compiler model."""
    lines = ["Process these layers in strict priority order."]
    for index, key in enumerate(PROMPT_LAYER_ORDER, start=1):
        value = non_empty_layers.get(key, "").strip()
        if value:
            lines.append(f"LAYER {index} — {key}")
            lines.append(value)
    return "\n".join(lines).strip()


def compile_base_prompt(
    non_empty_layers: dict[str, str],
    compiler_provider: ProviderSpec | None,
) -> str:
    """Compile the layers into one compact prompt."""
    if compiler_provider is not None:
        # Simplified for now, or use fallback if it fails
        try:
             compiled = _compile_with_llm(non_empty_layers, compiler_provider)
             if compiled:
                 return compiled
        except Exception:
             pass
    return _compact_fallback(non_empty_layers)


def _compile_with_llm(non_empty_layers: dict[str, str], provider: ProviderSpec) -> str:
    """Call the LLM to compile the layers."""
    from app.subsystems.text.client import chat_completion
    messages = get_prompt_compiler_messages(non_empty_layers)
    try:
        compiled = chat_completion(
            provider,
            messages,
            options=PROMPT_COMPILER_OPTIONS,
            timeout=30.0,
        ).strip()
        return _sanitize_compiled(compiled)
    except Exception:
        return ""


def _sanitize_compiled(compiled: str) -> str:
    """Clean up the model response."""
    cleaned = compiled.strip().strip("`").strip()
    if cleaned.lower().startswith("text"):
        cleaned = cleaned[4:].strip()
    return utils.normalize_instruction_text(cleaned)


def _compact_fallback(non_empty_layers: dict[str, str]) -> str:
    """Deterministic fallback for when LLM compilation is unavailable or fails."""
    # Simplified logic from service.py
    parts = []
    for key in PROMPT_LAYER_ORDER:
        if key in non_empty_layers:
            parts.append(non_empty_layers[key])
    return " ".join(parts).strip()


def is_valid_compiled_prompt(text: str) -> bool:
    """Return True when the text looks like a valid prompt paragraph."""
    cleaned = str(text or "").strip()
    # Basic heuristic
    return len(cleaned) > 20 and " " in cleaned
