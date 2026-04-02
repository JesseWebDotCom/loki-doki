"""Helpers shared by repository-backed local skills."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from app import db
from app.config import get_app_config
from app.skills.state_store import get_state, set_state
from app.subsystems.text.web_search import SEARCH_EMPTY, SEARCH_ERROR, search_web

APP_CONFIG = get_app_config()
GLOBAL_OWNER_ID = "global"


def read_shared_list(state_key: str, *, database_path: str = "") -> list[dict[str, Any]]:
    """Return one shared JSON list."""
    with db.connection_scope(_database_path(database_path)) as conn:
        return list(get_state(conn, scope="shared", owner_id=GLOBAL_OWNER_ID, state_key=state_key, default=[]))


def write_shared_list(state_key: str, items: list[dict[str, Any]], *, database_path: str = "") -> None:
    """Persist one shared JSON list."""
    with db.connection_scope(_database_path(database_path)) as conn:
        set_state(conn, scope="shared", owner_id=GLOBAL_OWNER_ID, state_key=state_key, value=items)


def read_user_list(user_id: str, state_key: str, *, database_path: str = "") -> list[dict[str, Any]]:
    """Return one user-scoped JSON list."""
    with db.connection_scope(_database_path(database_path)) as conn:
        return list(get_state(conn, scope="user", owner_id=user_id, state_key=state_key, default=[]))


def write_user_list(user_id: str, state_key: str, items: list[dict[str, Any]], *, database_path: str = "") -> None:
    """Persist one user-scoped JSON list."""
    with db.connection_scope(_database_path(database_path)) as conn:
        set_state(conn, scope="user", owner_id=user_id, state_key=state_key, value=items)


def parsed_search_results(query: str, *, max_results: int = 5) -> list[dict[str, str]]:
    """Return normalized search result dictionaries from the existing search helper."""
    result = search_web(query)
    if result.context in {SEARCH_EMPTY, SEARCH_ERROR}:
        return []
    return parse_search_context(result.context, source=result.source, max_results=max_results)


def parse_search_context(context: str, *, source: str, max_results: int = 5) -> list[dict[str, str]]:
    """Parse one formatted search context block into normalized result dictionaries."""
    items: list[dict[str, str]] = []
    for block in context.split("\n---\n"):
        title = _search_result_title(block)
        url = _capture_line(block, "URL:")
        snippet = _capture_line(block, "Snippet:")
        if title or url or snippet:
            items.append(
                {
                    "title": title,
                    "url": url,
                    "snippet": snippet,
                    "source": source,
                }
            )
        if len(items) >= max_results:
            break
    return items


def compact_slug(value: str) -> str:
    """Return a stable lowercase slug."""
    lowered = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return lowered or "item"


def title_case_phrase(value: str) -> str:
    """Return a user-facing title for a short phrase."""
    cleaned = " ".join(value.strip().split())
    if not cleaned:
        return ""
    return cleaned if any(character.isupper() for character in cleaned) else cleaned.title()


def _capture_line(block: str, prefix: str) -> str:
    """Extract one prefixed line from a formatted search block."""
    for line in block.splitlines():
        if line.startswith(prefix):
            return line.removeprefix(prefix).strip()
    return ""


def _search_result_title(block: str) -> str:
    """Extract a result title from either legacy or current search formatting."""
    title = _capture_line(block, "Title:")
    if title:
        return title
    for line in block.splitlines():
        cleaned = line.strip()
        if cleaned.startswith("Source [") and "]:" in cleaned:
            return cleaned.split("]:", 1)[1].strip()
    return ""


def _database_path(database_path: str) -> Path:
    """Return the requested database path or the app default."""
    return Path(database_path) if database_path else APP_CONFIG.database_path
