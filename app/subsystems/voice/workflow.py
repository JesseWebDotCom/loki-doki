"""Voice turn orchestration helpers."""

from __future__ import annotations

from dataclasses import dataclass

from app.classifier import Classification
from app.orchestrator import OrchestratedResponse, route_message
from app.providers.types import ProviderSpec
from app.subsystems.voice.service import transcribe_audio


@dataclass(frozen=True)
class VoiceChatResult:
    """Resolved push-to-talk transcript plus routed chat reply."""

    transcript: str
    reply: str
    provider: ProviderSpec
    classification: Classification


def run_push_to_talk_turn(
    audio_base64: str,
    mime_type: str,
    stt_model: str,
    username: str,
    profile: str,
    history: list[dict[str, str]],
    providers: dict[str, ProviderSpec],
) -> VoiceChatResult:
    """Transcribe one recorded clip and route it through the text chat pipeline."""
    transcript = transcribe_audio(audio_base64, mime_type, stt_model)
    result: OrchestratedResponse = route_message(
        transcript,
        username,
        profile,
        history,
        providers,
    )
    return VoiceChatResult(
        transcript=transcript,
        reply=result.reply,
        provider=result.provider,
        classification=result.classification,
    )
