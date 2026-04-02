"""Voice subsystem helpers."""

from typing import TYPE_CHECKING, Any

from app.subsystems.voice.service import VoiceTranscriptionError, transcribe_audio
from app.subsystems.voice.wakeword import (
    DEFAULT_WAKEWORD_THRESHOLD,
    WakewordError,
    WakewordSessionManager,
    WakewordSource,
    get_wakeword_source,
    install_wakeword_from_upload,
    install_wakeword_from_url,
    list_wakeword_sources,
    wakeword_runtime_status,
)

if TYPE_CHECKING:
    from app.subsystems.voice.workflow import VoiceChatResult

__all__ = [
    "DEFAULT_WAKEWORD_THRESHOLD",
    "install_wakeword_from_upload",
    "install_wakeword_from_url",
    "VoiceChatResult",
    "VoiceTranscriptionError",
    "WakewordError",
    "WakewordSessionManager",
    "WakewordSource",
    "get_wakeword_source",
    "list_wakeword_sources",
    "run_push_to_talk_turn",
    "transcribe_audio",
    "wakeword_runtime_status",
]


def __getattr__(name: str) -> Any:
    """Lazily expose workflow helpers without creating import cycles."""
    if name in {"VoiceChatResult", "run_push_to_talk_turn"}:
        from app.subsystems.voice import workflow

        return getattr(workflow, name)
    raise AttributeError(name)
