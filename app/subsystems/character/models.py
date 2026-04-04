"""Character-related data models and constants."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any, Optional


DEFAULT_CORE_SAFETY_PROMPT = (
    "You are LokiDoki, a private local-first household assistant running on the user's own device. "
    "Be honest about uncertainty, do not fabricate tool or live-data results, do not claim to be unrelated "
    "to LokiDoki, and follow the configured account, user, care-profile, and character rules in priority order. "
    "If a user corrects you on a fact (especially about TV, movies, or books), do not argue. "
    "Acknowledge the correction and use web search or tools to verify if needed. "
    "Do not end every response with a follow-up question. Answer directly and let the user lead the conversation."
)
DEFAULT_BLOCKED_TOPIC_REPLY = "I can't help with that topic right now."
PRIORITY_HEADER = "Follow these instruction layers in strict priority order. Higher-priority layers always win if any instruction conflicts."
PROMPT_COMPILER_VERSION = "v4"
PROMPT_LAYER_ORDER = (
    "core_safety_prompt",
    "device_policy_prompt",
    "user_admin_prompt",
    "project_prompt",
    "care_profile_prompt",
    "character_prompt",
    "character_custom_prompt",
    "user_prompt",
)
PROMPT_STAGE_GROUPS = {
    "device": [
        "core_safety_prompt",
        "device_policy_prompt",
    ],
    "user": [
        "user_admin_prompt",
        "care_profile_prompt",
    ],
    "character": [
        "character_prompt",
        "character_custom_prompt",
    ],
    "project": [
        "project_prompt",
    ],
    "user_prefs": [
        "user_prompt",
    ],
}
SENTENCE_SPLIT_PATTERN = re.compile(r"(?<=[.!?])\s+")
PROMPT_COMPILER_OPTIONS: dict[str, int | float] = {"temperature": 0, "num_predict": 256}
PROFANITY_PATTERN = re.compile(
    r"\b(fuck(?:er|ing|ed|s)?|shit(?:ty)?|damn|bitch(?:es)?|asshole|bastard)\b",
    flags=re.IGNORECASE,
)


@dataclass(frozen=True)
class CharacterDefinition:
    """Loaded character definition."""

    character_id: str
    name: str
    version: str
    source: str
    system_prompt: str
    default_voice: str
    default_voice_download_url: str
    default_voice_config_download_url: str
    default_voice_source_name: str
    default_voice_config_source_name: str
    wakeword_model_id: str
    wakeword_download_url: str
    wakeword_source_name: str
    capabilities: dict[str, Any]
    logo: str
    description: str
    path: str
    teaser: str = ""
    phonetic_spelling: str = ""
    identity_key: str = ""
    domain: str = ""
    behavior_style: str = ""
    preferred_response_style: str = "balanced"
    voice_model: str = ""
    character_editor: dict[str, Any] = field(default_factory=dict)
    enabled: bool = True
    builtin: bool = False
    installed: bool = True

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-safe payload."""
        payload = asdict(self)
        payload["id"] = payload.pop("character_id")
        return payload


@dataclass(frozen=True)
class ParsedModelResponse:
    """Structured response parsed from one model call."""

    summary: str
    metadata: dict[str, Any]
    final_text: str
    raw_text: str


@dataclass(frozen=True)
class CharacterRenderingContext:
    """Resolved prompt layers for one chat turn."""

    user_id: str
    account_id: str
    display_name: str
    profile: str
    active_character_id: Optional[str]
    segments: dict[str, str] = field(default_factory=dict)
    base_prompt_hash: str = ""
    active_character_name: str = "LokiDoki"
    character_behavior_style: str = ""
    character_preferred_response_style: str = "balanced"
    care_profile_id: str = "standard"
    care_profile_sentence_length: str = "medium"
    care_profile_response_style: str = "balanced"
    character_enabled: bool = True
    proactive_chatter_enabled: bool = False
    blocked_topics: tuple[str, ...] = ()
    max_response_tokens: int = 160
    debug: dict[str, Any] = field(default_factory=dict)

    @property
    def base_prompt(self) -> str:
        """Assembles the final system prompt from prioritized segments."""
        if not self.segments:
            return ""
        
        # Start with the authoritative priority header
        assembled = [PRIORITY_HEADER]
        
        # Join non-empty segments in prioritized order (Device, User, Character, Project, User Prefs)
        # We rely on the dict keys being in order from PROMPT_STAGE_GROUPS/compiler
        for segment_text in self.segments.values():
            text = str(segment_text or "").strip()
            if text:
                assembled.append(text)
                
        return "\n\n".join(assembled).strip()
