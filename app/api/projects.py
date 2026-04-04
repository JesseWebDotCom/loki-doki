"""Project-related API routes."""

from __future__ import annotations

from typing import Any, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status

from app.deps import connection_scope, get_current_user
from app.models.project import ProjectCreate, ProjectUpdate, ProjectResponse
from app.projects import store as project_store

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=List[ProjectResponse])
def get_projects_api(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> List[dict[str, Any]]:
    """Retrieve all projects for the current user."""
    with connection_scope() as connection:
        return project_store.list_projects(connection, current_user["id"])


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project_api(
    payload: ProjectCreate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Create a new project."""
    with connection_scope() as connection:
        return project_store.create_project(
            connection,
            current_user["id"],
            name=payload.name,
            description=payload.description or "",
            instructions=payload.instructions or "",
            icon=payload.icon or "Folder",
            icon_color=payload.icon_color or "#3b82f6",
        )


@router.patch("/{project_id}", response_model=ProjectResponse)
def update_project_api(
    project_id: str,
    payload: ProjectUpdate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Update an existing project."""
    with connection_scope() as connection:
        try:
            return project_store.update_project(
                connection,
                current_user["id"],
                project_id,
                name=payload.name,
                description=payload.description,
                instructions=payload.instructions,
                icon=payload.icon,
                icon_color=payload.icon_color,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_api(
    project_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
):
    """Delete a project."""
    with connection_scope() as connection:
        project_store.delete_project(connection, current_user["id"], project_id)
    return None


@router.patch("/chats/{chat_id}/assign")
def assign_chat_to_project_api(
    chat_id: str,
    project_id: Optional[str] = None,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Update a chat session to belong to a specific project."""
    from app.chats import store as chat_store
    with connection_scope() as connection:
        # Verify chat belongs to user
        chat = chat_store.get_chat_summary(connection, current_user["id"], chat_id)
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found or access denied.")
        
        # Verify project belongs to user if provided
        if project_id:
            project = project_store.get_project(connection, current_user["id"], project_id)
            if not project:
                raise HTTPException(status_code=404, detail="Project not found or access denied.")
        
        connection.execute(
            "UPDATE chat_sessions SET project_id = ? WHERE id = ? AND user_id = ?",
            (project_id, chat_id, current_user["id"]),
        )
        connection.commit()
    return {"status": "success", "chat_id": chat_id, "project_id": project_id}
