"""Character-related API routes."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app import db
from app.deps import APP_CONFIG, connection_scope, get_current_user, enforce_admin
from app.models.character import (
    CharacterInstallRequest,
    CharacterUpdateRequest,
    CharacterImportRequest,
)
from app.subsystems.character import character_service, utils as character_utils
from app.runtime import runtime_context

router = APIRouter(prefix="/characters", tags=["characters"])


def _compile_prompts_for_account(
    conn: Any,
    context: dict[str, Any],
    account_id: str,
) -> None:
    """Compile and persist compact prompts for all users in one account."""
    for user in db.list_users(conn):
        if str(user.get("account_id") or "") != account_id:
            continue
        character_service.build_rendering_context(
            conn,
            user,
            context["settings"]["profile"],
            compiler_provider=context["providers"]["llm_fast"],
        )


@router.get("")
def get_characters(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """Return the installed character catalog."""
    del current_user
    with connection_scope() as connection:
        return character_service.list_characters(connection, APP_CONFIG)


@router.get("/{character_id}/logo")
def get_character_logo(character_id: str) -> FileResponse:
    """Serve one local character logo asset for the UI."""
    with connection_scope() as connection:
        row = connection.execute(
            "SELECT * FROM character_catalog WHERE character_id = ?",
            (character_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Character not found.")
    character = character_utils.row_to_definition(row)
    logo_value = str(row["logo"] or "").strip()
    if not logo_value or logo_value.startswith(("http://", "https://", "data:", "/")):
        raise HTTPException(status_code=404, detail="Character logo is not a local asset.")
    manifest_path = Path(character.path) / "character.json"
    character_utils.validate_manifest_path(manifest_path, APP_CONFIG)
    logo_path = Path(character.path) / logo_value
    if not logo_path.exists() or not logo_path.is_file():
        raise HTTPException(status_code=404, detail="Character logo asset is missing.")
    return FileResponse(str(logo_path))


@router.post("/install")
def install_character_api(
    payload: CharacterInstallRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Install or refresh one local character package."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            character = character_service.install_character(connection, APP_CONFIG, payload.character_id.strip())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        _compile_prompts_for_account(connection, context, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))
        return {"ok": True, "character": character, **character_service.list_characters(connection, APP_CONFIG)}


@router.post("/{character_id}/enable")
def enable_character_api(
    character_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Enable one character in the catalog."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            character = character_service.set_catalog_enabled(connection, character_id, True)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        _compile_prompts_for_account(connection, context, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))
    return {"ok": True, "character": character}


@router.post("/{character_id}/disable")
def disable_character_api(
    character_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Disable one character in the catalog."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            character = character_service.set_catalog_enabled(connection, character_id, False)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        _compile_prompts_for_account(connection, context, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))
    return {"ok": True, "character": character}


@router.post("/{character_id}/reload")
def reload_character_api(
    character_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Reload one character from the local repository or built-ins."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            character_service.initialize(connection, APP_CONFIG)
            character = character_service.install_character(connection, APP_CONFIG, character_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        _compile_prompts_for_account(connection, context, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))
        return {"ok": True, "character": character}


@router.delete("/{character_id}")
def delete_character_api(
    character_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete one repository-backed character."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            payload = character_service.delete_character(connection, APP_CONFIG, character_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        _compile_prompts_for_account(connection, context, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))
        return {"ok": True, **payload}


@router.put("/{character_id}")
def update_character_api(
    character_id: str,
    payload: CharacterUpdateRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Persist editable metadata to one local character manifest."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            character = character_service.update_character_manifest(
                connection,
                APP_CONFIG,
                character_id,
                payload.dict(exclude_unset=True),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        _compile_prompts_for_account(connection, context, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))
        return {"ok": True, "character": character, **character_service.list_characters(connection, APP_CONFIG)}


@router.get("/{character_id}/export")
def export_character_api(
    character_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Export one character as a portable JSON package."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        try:
            package = character_service.export_character_package(connection, character_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "package": package}


@router.post("/{character_id}/publish")
def publish_character_api(
    character_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Publish one installed character into the local characters repository."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        try:
            published = character_service.publish_character_to_repository(connection, APP_CONFIG, character_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "published": published}


@router.post("/import")
def import_character_api(
    payload: CharacterImportRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Import one portable character package into the repository catalog."""
    enforce_admin(current_user)
    with connection_scope() as connection:
        context = runtime_context(connection, APP_CONFIG)
        try:
            character = character_service.import_character_package(
                connection,
                APP_CONFIG,
                payload.package,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        _compile_prompts_for_account(connection, context, str(current_user.get("account_id") or db.DEFAULT_ACCOUNT_ID))
        return {"ok": True, "character": character, **character_service.list_characters(connection, APP_CONFIG)}
