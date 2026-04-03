"""Voice and wakeword API routes."""

from __future__ import annotations

import base64
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from app.api.chat_helpers import generate_chat_assistant_message
from app.chats import store as chat_store
from app.deps import APP_CONFIG, connection_scope, get_current_user
from app.models.voice import (
    CustomPiperInstallRequest,
    PiperInstallRequest,
    UpdateCustomPiperVoiceRequest,
    VoiceChatRequest,
    VoiceLiveTranscribeRequest,
    VoiceSpeakRequest,
    VoiceStreamRequest,
    VoiceTranscribeRequest,
    WakewordDetectRequest,
    WakewordSettingsRequest,
)
from app.providers.piper_service import (
    install_voice,
    install_voice_from_upload,
    install_voice_from_url,
    piper_status,
    refresh_upstream_voice_catalog,
    reinstall_voice,
    remove_voice,
    synthesize,
    synthesize_stream,
    update_custom_voice,
    voice_catalog,
    voice_catalog_status,
    warm_voice,
)
from app.runtime import runtime_context
from app.settings import store as settings_store
from app.subsystems.voice import (
    DEFAULT_WAKEWORD_THRESHOLD,
    VoiceTranscriptionError,
    WakewordError,
    list_wakeword_sources,
    run_push_to_talk_turn,
    transcribe_audio,
    wakeword_runtime_status,
)

router = APIRouter(prefix="", tags=["voice"])


def _selected_voice_id(user_id: str, requested_voice_id: str | None = None) -> str:
    """Return the requested or saved Piper voice id for one user."""
    with connection_scope() as connection:
        preferences = settings_store.load_voice_preferences(connection, user_id)
    return str(requested_voice_id or preferences["piper_voice_id"]).strip()


def _voice_payload(user_id: str) -> dict[str, Any]:
    """Return the voice payload expected by the React app."""
    with connection_scope() as connection:
        preferences = settings_store.load_voice_preferences(connection, user_id)
    return {
        "voice_source": str(preferences["voice_source"]),
        "browser_voice_uri": str(preferences["browser_voice_uri"]),
        "piper_voice_id": str(preferences["piper_voice_id"]),
        "reply_enabled": bool(preferences["reply_enabled"]),
        "barge_in_enabled": bool(preferences["barge_in_enabled"]),
        "piper": {
            "status": piper_status(str(preferences["piper_voice_id"])),
            "catalog": voice_catalog(),
        },
    }


def _wakeword_payload(user_id: str) -> dict[str, Any]:
    """Return the wakeword payload expected by the React app."""
    with connection_scope() as connection:
        preferences = settings_store.load_wakeword_preferences(connection, user_id)
    model_id = str(preferences["model_id"] or "loki_doki").strip() or "loki_doki"
    return {
        "enabled": bool(preferences["enabled"]),
        "model_id": model_id,
        "threshold": float(preferences["threshold"]),
        "sources": [source.to_dict() for source in list_wakeword_sources()],
        "status": wakeword_runtime_status(model_id),
    }


def _stt_model_label() -> str:
    """Return the active speech-to-text model label."""
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
    return str(context["models"]["stt_model"])


@router.get("/voice/piper/status")
def get_piper_status(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return local Piper runtime status for the active user."""
    return piper_status(_selected_voice_id(current_user["id"]))


@router.get("/voice/catalog")
def get_voice_catalog(current_user: dict[str, Any] = Depends(get_current_user)) -> list[dict[str, object]]:
    """Return the Piper voice catalog."""
    del current_user
    return voice_catalog()


@router.get("/voice/catalog/status")
def get_voice_catalog_status(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, object]:
    """Return upstream Piper catalog metadata."""
    del current_user
    return voice_catalog_status()


@router.post("/voice/catalog/refresh")
def refresh_voice_catalog_api(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, object]:
    """Refresh the upstream Piper voice catalog."""
    del current_user
    return refresh_upstream_voice_catalog()


@router.post("/voice/piper/install")
def install_piper_voice_api(
    payload: PiperInstallRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, object]:
    """Install one Piper voice."""
    del current_user
    try:
        return install_voice(payload.voice_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/voice/piper/install-custom")
def install_custom_piper_voice_api(
    payload: CustomPiperInstallRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, object]:
    """Install one custom Piper voice from URLs or uploaded data."""
    del current_user
    try:
        if payload.model_url.strip():
            return install_voice_from_url(
                payload.voice_id,
                payload.model_url,
                config_url=payload.config_url,
                label=payload.label,
                description=payload.description,
                language=payload.language,
                quality=payload.quality,
                gender=payload.gender,
            )
        return install_voice_from_upload(
            payload.voice_id,
            payload.model_data_url,
            payload.config_data_url,
            label=payload.label,
            description=payload.description,
            model_source_name=payload.model_source_name,
            config_source_name=payload.config_source_name,
            language=payload.language,
            quality=payload.quality,
            gender=payload.gender,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.put("/voice/piper/custom/{voice_id}")
def update_custom_piper_voice_api(
    voice_id: str,
    payload: UpdateCustomPiperVoiceRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, object]:
    """Update custom Piper voice metadata."""
    del current_user
    try:
        return update_custom_voice(
            voice_id,
            label=payload.label,
            description=payload.description,
            model_url=payload.model_url,
            config_url=payload.config_url,
            language=payload.language,
            quality=payload.quality,
            gender=payload.gender,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/voice/piper/{voice_id}/reinstall")
def reinstall_piper_voice_api(
    voice_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, object]:
    """Reinstall one Piper voice."""
    del current_user
    try:
        return reinstall_voice(voice_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/voice/piper/{voice_id}/warm")
def warm_piper_voice_api(
    voice_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, object]:
    """Warm one Piper voice into process memory."""
    del current_user
    try:
        return warm_voice(voice_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete("/voice/piper/{voice_id}")
def remove_piper_voice_api(
    voice_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, object]:
    """Remove one custom Piper voice."""
    del current_user
    try:
        return remove_voice(voice_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/voice/speak")
def voice_speak_api(
    payload: VoiceSpeakRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> Response:
    """Synthesize a WAV response using the selected Piper voice."""
    voice_id = _selected_voice_id(current_user["id"], payload.voice_id)
    if not voice_id:
        raise HTTPException(status_code=400, detail="No voice selected.")
    try:
        return Response(content=synthesize(payload.text, voice_id), media_type="audio/wav")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/voice/speak-stream")
def voice_speak_stream_api(
    payload: VoiceStreamRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> StreamingResponse:
    """Compatibility wrapper for the plural streaming route."""
    return voices_stream_api(payload, current_user)


@router.post("/voice/transcribe")
def voice_transcribe_api(
    payload: VoiceTranscribeRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Transcribe one recorded push-to-talk clip."""
    del current_user
    try:
        transcript = transcribe_audio(payload.audio_base64, payload.mime_type, _stt_model_label())
        return {"transcript": transcript, "text": transcript}
    except (VoiceTranscriptionError, Exception) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/voice/transcribe-live")
@router.post("/voice/transcribe/live")
def voice_transcribe_live_api(
    payload: VoiceLiveTranscribeRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Transcribe one live capture chunk."""
    del current_user
    try:
        transcript = transcribe_audio(payload.audio_base64, payload.mime_type, _stt_model_label())
        return {
            "transcript": transcript,
            "text": transcript,
            "sequence": payload.sequence,
            "is_final": payload.is_final,
        }
    except (VoiceTranscriptionError, Exception) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/voice/chat")
def voice_chat_api(
    payload: VoiceChatRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Transcribe one recorded clip and run it through the chat pipeline."""
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        chat = chat_store.resolve_chat(connection, current_user["id"], payload.chat_id)
        history = chat_store.load_chat_history(connection, current_user["id"], str(chat["id"]))
    try:
        result = run_push_to_talk_turn(
            payload.audio_base64,
            payload.mime_type,
            str(context["models"]["stt_model"]),
            current_user["display_name"],
            context["settings"]["profile"],
            history,
            context["providers"],
        )
    except (VoiceTranscriptionError, Exception) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    transcript = result.transcript.strip()
    if not transcript:
        return {"chat_id": str(chat["id"]), "transcript": "", "message": None}

    user_message = {"role": "user", "content": transcript}
    with connection_scope() as connection:
        chat_store.append_chat_message(connection, current_user["id"], str(chat["id"]), user_message)
        history = chat_store.load_chat_history(connection, current_user["id"], str(chat["id"]))
        assistant_message = generate_chat_assistant_message(
            connection,
            current_user,
            context["settings"]["profile"],
            history[:-1],
            context["providers"],
            transcript,
            chat_id=str(chat["id"]),
            response_style=payload.response_style or "brief",
        )
        chat_store.append_chat_message(connection, current_user["id"], str(chat["id"]), assistant_message)
        chats = chat_store.list_chat_summaries(connection, current_user["id"])
    return {
        "chat_id": str(chat["id"]),
        "transcript": transcript,
        "message": assistant_message,
        "assistant_message": assistant_message,
        "chats": chats,
    }


@router.post("/voice/chat-recorded")
def voice_chat_recorded_api(
    payload: VoiceChatRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Backwards-compatible alias for recorded voice chat."""
    return voice_chat_api(payload, current_user)


@router.get("/voice/wakeword/status")
def get_wakeword_status(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, object]:
    """Return runtime status for the selected wakeword model."""
    with connection_scope() as connection:
        preferences = settings_store.load_wakeword_preferences(connection, current_user["id"])
    return wakeword_runtime_status(str(preferences["model_id"]))


@router.get("/voice/wakeword/sources")
def get_wakeword_sources(current_user: dict[str, Any] = Depends(get_current_user)) -> list[dict[str, object]]:
    """Return installed wakeword sources."""
    del current_user
    return [source.to_dict() for source in list_wakeword_sources()]


@router.post("/voice/wakeword/detect")
def wakeword_detect_api(
    request: Request,
    payload: WakewordDetectRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Analyze one audio chunk for wakeword activation."""
    with connection_scope() as connection:
        preferences = settings_store.load_wakeword_preferences(connection, current_user["id"])
    if not preferences["enabled"]:
        return {
            "detected": False,
            "score": 0.0,
            "ready": False,
            "detail": "Wakeword is disabled.",
            "model_id": str(preferences["model_id"]),
        }
    sessions = getattr(request.app.state, "wakeword_sessions", None)
    if not sessions:
        raise HTTPException(status_code=500, detail="Wake-word engine not initialized.")
    try:
        result = sessions.detect(
            current_user["id"],
            str(preferences["model_id"]),
            float(preferences["threshold"] or DEFAULT_WAKEWORD_THRESHOLD),
            payload.audio_base64,
            payload.sample_rate,
        )
        return result.to_dict()
    except (WakewordError, Exception) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/voices")
def voices_payload_api(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Compatibility route returning voice settings for the app shell."""
    return _voice_payload(current_user["id"])


@router.post("/voices/warm")
def warm_selected_voice_api(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, object]:
    """Warm the active user's selected Piper voice."""
    voice_id = _selected_voice_id(current_user["id"])
    if not voice_id:
        raise HTTPException(status_code=400, detail="No Piper voice selected.")
    try:
        return warm_voice(voice_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/voices/piper/install")
def install_piper_voice_plural_api(
    payload: PiperInstallRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, object]:
    """Compatibility alias for installing Piper voices from the app shell."""
    return install_piper_voice_api(payload, current_user)


@router.post("/voices/speak")
def voices_speak_api(
    payload: VoiceSpeakRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> Response:
    """Compatibility alias for WAV Piper synthesis."""
    return voice_speak_api(payload, current_user)


@router.post("/voices/stream")
def voices_stream_api(
    payload: VoiceStreamRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> StreamingResponse:
    """Stream Piper output as ndjson chunks for the browser voice player."""
    voice_id = _selected_voice_id(current_user["id"], payload.voice_id)
    if not voice_id:
        raise HTTPException(status_code=400, detail="No voice selected.")

    def iter_chunks():
        try:
            for chunk in synthesize_stream(payload.text, voice_id):
                yield json.dumps(
                    {
                        "audio_base64": base64.b64encode(chunk["audio_pcm"]).decode("ascii"),
                        "sample_rate": int(chunk["sample_rate"]),
                        "phonemes": list(chunk["phonemes"]),
                        "samples_per_phoneme": int(chunk["samples_per_phoneme"]),
                    }
                ) + "\n"
        except Exception as exc:
            yield json.dumps({"error": str(exc)}) + "\n"

    return StreamingResponse(iter_chunks(), media_type="application/x-ndjson")


@router.get("/wakeword")
def wakeword_payload_api(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Compatibility route returning wakeword settings for the app shell."""
    return _wakeword_payload(current_user["id"])


@router.put("/wakeword")
def update_wakeword_api(
    payload: WakewordSettingsRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Persist wakeword preferences and return the refreshed payload."""
    with connection_scope() as connection:
        preferences = settings_store.load_wakeword_preferences(connection, current_user["id"])
        if payload.enabled is not None:
            preferences["enabled"] = bool(payload.enabled)
        if payload.model_id is not None:
            preferences["model_id"] = str(payload.model_id or "loki_doki").strip() or "loki_doki"
        if payload.threshold is not None:
            preferences["threshold"] = float(payload.threshold)
        settings_store.save_wakeword_preferences(connection, current_user["id"], preferences)
    return _wakeword_payload(current_user["id"])


@router.post("/wakeword/detect")
def wakeword_detect_plural_api(
    request: Request,
    payload: WakewordDetectRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Compatibility alias for wakeword chunk detection."""
    return wakeword_detect_api(request, payload, current_user)
