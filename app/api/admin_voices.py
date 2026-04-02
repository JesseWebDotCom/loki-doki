"""Admin voice catalog and management routes."""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from app.deps import APP_CONFIG, connection_scope, enforce_admin, get_current_user
from app.models.voice import (
    CustomPiperInstallRequest,
    UpdateCustomPiperVoiceRequest,
    VoiceSpeakRequest,
)
from app.providers.piper_service import (
    config_path,
    install_voice_from_upload,
    install_voice_from_url,
    model_path,
    refresh_upstream_voice_catalog,
    reinstall_voice,
    remove_voice,
    synthesize,
    update_custom_voice,
    voice_catalog,
    voice_catalog_status,
)
from app.subsystems.character import character_service


router = APIRouter(prefix="/admin/voices", tags=["admin"])


def _character_voice_map(conn: sqlite3.Connection) -> dict[str, list[dict[str, str]]]:
    """Return character usage grouped by default voice id."""
    characters = character_service.list_characters(conn, APP_CONFIG)["available"]
    voice_map: dict[str, list[dict[str, str]]] = {}
    for character in characters:
        voice_id = str(character.get("default_voice") or "").strip()
        if not voice_id:
            continue
        voice_map.setdefault(voice_id, []).append(
            {
                "character_id": str(character.get("id") or ""),
                "character_name": str(character.get("name") or ""),
            }
        )
    return voice_map


def _model_display_path(voice_id: str) -> str:
    """Return the installed model path for one voice when present."""
    path = model_path(voice_id)
    return str(path) if path.exists() else ""


def _config_display_path(voice_id: str) -> str:
    """Return the installed config path for one voice when present."""
    path = config_path(voice_id)
    return str(path) if path.exists() else ""


def _admin_voice_payload(conn: sqlite3.Connection) -> dict[str, Any]:
    """Return the administration voice payload consumed by the React app."""
    character_map = _character_voice_map(conn)
    voices = []
    for voice in voice_catalog():
        voice_id = str(voice.get("id") or "").strip()
        voices.append(
            {
                **voice,
                "custom": bool(voice.get("custom")),
                "curated": bool(voice.get("curated")),
                "gender": str(voice.get("gender") or ""),
                "source_url": str(voice.get("source_url") or voice.get("model_url") or ""),
                "config_url": str(voice.get("config_url") or ""),
                "model_source_name": str(voice.get("model_source_name") or ""),
                "config_source_name": str(voice.get("config_source_name") or ""),
                "model_path": _model_display_path(voice_id),
                "config_path": _config_display_path(voice_id),
                "characters": character_map.get(voice_id, []),
            }
        )
    return {
        "voices": voices,
        "catalog_status": voice_catalog_status(),
    }


@router.get("")
def list_admin_voices(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return the admin voice catalog with install state and character usage."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        return _admin_voice_payload(connection)


@router.post("/custom")
def install_admin_custom_voice(
    payload: CustomPiperInstallRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Install one custom Piper voice for the admin catalog."""
    enforce_admin(current_user)
    try:
        if payload.model_url.strip():
            install_voice_from_url(
                payload.voice_id,
                payload.model_url,
                config_url=payload.config_url,
                label=payload.label,
                description=payload.description,
                language=payload.language,
                quality=payload.quality,
                gender=payload.gender,
            )
        else:
            install_voice_from_upload(
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
    with connection_scope() as connection:
        return {"voices": _admin_voice_payload(connection)["voices"]}


@router.put("/{voice_id}")
def update_admin_custom_voice(
    voice_id: str,
    payload: UpdateCustomPiperVoiceRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Update one custom Piper voice entry for the admin catalog."""
    enforce_admin(current_user)
    try:
        update_custom_voice(
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
    with connection_scope() as connection:
        return _admin_voice_payload(connection)


@router.post("/{voice_id}/reinstall")
def reinstall_admin_voice(
    voice_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Reinstall one voice and return the refreshed admin catalog."""
    enforce_admin(current_user)
    try:
        reinstall_voice(voice_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    with connection_scope() as connection:
        return {"voices": _admin_voice_payload(connection)["voices"]}


@router.delete("/{voice_id}")
def remove_admin_voice(
    voice_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Remove one custom voice and return the refreshed admin catalog."""
    enforce_admin(current_user)
    try:
        remove_voice(voice_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    with connection_scope() as connection:
        return {"voices": _admin_voice_payload(connection)["voices"]}


@router.post("/catalog/refresh")
def refresh_admin_voice_catalog(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Refresh the upstream Piper catalog cache for the admin UI."""
    enforce_admin(current_user)
    refresh_upstream_voice_catalog()
    with connection_scope() as connection:
        return _admin_voice_payload(connection)


@router.post("/{voice_id}/preview")
def preview_admin_voice(
    voice_id: str,
    payload: VoiceSpeakRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> Response:
    """Synthesize one admin voice preview clip."""
    enforce_admin(current_user)
    try:
        return Response(content=synthesize(payload.text, voice_id), media_type="audio/wav")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
