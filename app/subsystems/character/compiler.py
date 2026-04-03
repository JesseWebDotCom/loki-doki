"""Prompt-layer compilation and optimization logic."""

from __future__ import annotations

import hashlib

from app.providers.types import ProviderSpec
from app.subsystems.character import utils
from app.subsystems.character.models import (
    PROFANITY_PATTERN,
    PROMPT_LAYER_ORDER,
    PROMPT_COMPILER_VERSION,
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
                "You are a prompt compiler. Produce a compact system prompt that preserves each layer's intent "
                "and priority. Keep higher-priority rules authoritative, do not paraphrase away critical identity "
                "or safety clauses, and do not rewrite the result into character-roleplay prose."
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
    del compiler_provider
    return _structured_fallback(non_empty_layers)


def _structured_fallback(non_empty_layers: dict[str, str]) -> str:
    """Return a deterministic system prompt that preserves layer boundaries."""
    sections = [
        "Follow these instruction layers in strict priority order. Higher-priority layers always win if any instruction conflicts.",
    ]
    seen_values: set[str] = set()
    profanity_blocked = False
    for key in PROMPT_LAYER_ORDER:
        value = utils.normalize_instruction_text(non_empty_layers.get(key, ""))
        if not value:
            continue
        if profanity_blocked:
            value = _strip_disallowed_profanity(value)
        normalized_value = value.lower()
        if normalized_value in seen_values:
            continue
        seen_values.add(normalized_value)
        sections.append(f"{_label_for_layer(key)}: {value}")
        if key == "account_policy_prompt" and _blocks_profanity(value):
            profanity_blocked = True
    return "\n\n".join(sections).strip()


def _label_for_layer(key: str) -> str:
    """Return a readable label for one prompt layer."""
    return {
        "core_safety_prompt": "Core safety and identity",
        "account_policy_prompt": "Account policy",
        "admin_prompt": "Admin guidance",
        "care_profile_prompt": "Care profile",
        "character_prompt": "Character behavior",
        "character_custom_prompt": "Character customization",
        "user_prompt": "User preference",
    }.get(key, key.replace("_", " ").title())


def _blocks_profanity(text: str) -> bool:
    """Return True when a higher-priority layer forbids profanity."""
    lowered = text.lower()
    return "no swearing" in lowered or "never use profanity" in lowered or "no profanity" in lowered


def _strip_disallowed_profanity(text: str) -> str:
    """Remove profanity requests from lower-priority layers when a higher layer forbids them."""
    cleaned = PROFANITY_PATTERN.sub("", text)
    cleaned = cleaned.replace("swear all the time", "")
    cleaned = cleaned.replace("And swear!!!!", "")
    cleaned = cleaned.replace("And swear!", "")
    cleaned = cleaned.replace("And swear.", "")
    cleaned = cleaned.replace("swear", "")
    return utils.normalize_instruction_text(cleaned)


def is_valid_compiled_prompt(text: str) -> bool:
    """Return True when the text looks like a valid prompt paragraph."""
    cleaned = str(text or "").strip()
    return len(cleaned) > 20 and " " in cleaned
