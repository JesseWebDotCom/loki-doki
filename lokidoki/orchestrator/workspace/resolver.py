"""Resolve the active workspace for the current turn."""
from __future__ import annotations

import logging
from typing import Any

from lokidoki.orchestrator.workspace.store import (
    DEFAULT_WORKSPACE_ID,
    ensure_default_workspace,
    get_workspace,
    get_session_active_workspace_id,
    list_workspace_session_ids,
)
from lokidoki.orchestrator.workspace.types import Workspace

logger = logging.getLogger(__name__)


async def resolve_active_workspace(context: dict[str, Any]) -> Workspace:
    """Resolve and cache the active workspace for this request."""
    cached = context.get("_resolved_workspace")
    if isinstance(cached, Workspace):
        return cached
    provider = context.get("memory_provider")
    user_id = int(context.get("owner_user_id") or 0)
    if provider is None or user_id <= 0:
        workspace = Workspace(id=DEFAULT_WORKSPACE_ID, name="Default", persona_id="default", memory_scope="global")
        context["_resolved_workspace"] = workspace
        return workspace

    requested_workspace_id = context.get("active_workspace_id")
    session_id = context.get("session_id")

    def _resolve(conn):
        default = ensure_default_workspace(conn, user_id=user_id)
        workspace_id = str(requested_workspace_id).strip() if requested_workspace_id else ""
        if not workspace_id and session_id is not None:
            try:
                workspace_id = get_session_active_workspace_id(
                    conn, user_id=user_id, session_id=int(session_id),
                )
            except ValueError:
                workspace_id = DEFAULT_WORKSPACE_ID
        workspace = get_workspace(
            conn,
            user_id=user_id,
            workspace_id=workspace_id or DEFAULT_WORKSPACE_ID,
        )
        if workspace is None:
            logger.warning(
                "[workspace] missing workspace %r for user %s; falling back to default",
                workspace_id, user_id,
            )
            workspace = default
        session_ids: tuple[int, ...] = ()
        if workspace.memory_scope == "workspace":
            session_ids = list_workspace_session_ids(
                conn,
                user_id=user_id,
                workspace_id=workspace.id,
            )
        return workspace, session_ids

    if hasattr(provider, "run_sync") and callable(provider.run_sync):
        workspace, session_ids = await provider.run_sync(_resolve)
    else:
        store = getattr(provider, "store", None)
        conn = getattr(store, "_conn", None)
        if conn is None:
            workspace = Workspace(
                id=DEFAULT_WORKSPACE_ID,
                name="Default",
                persona_id="default",
                memory_scope="global",
            )
            context["_resolved_workspace"] = workspace
            return workspace
        workspace, session_ids = _resolve(conn)
    context["_resolved_workspace"] = workspace
    context["workspace"] = workspace
    context["workspace_id"] = workspace.id
    context["workspace_default_mode"] = workspace.default_mode
    context["workspace_persona_id"] = workspace.persona_id
    context["attached_corpora"] = list(workspace.attached_corpora)
    context["workspace_memory_scope"] = workspace.memory_scope
    context["workspace_session_ids"] = session_ids
    return workspace
