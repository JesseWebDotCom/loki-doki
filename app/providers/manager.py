"""Provider management and resolution."""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from app import db
from app.deps import APP_CONFIG
from app.providers import resolve_providers
from app.providers.types import ProviderSpec


def get_provider_for_subsystem(subsystem: str, model_type: str = "fast") -> Optional[ProviderSpec]:
    """Resolve a provider for a specific subsystem (e.g. 'memory', 'text_chat') from DB settings."""
    with db.connection_scope(APP_CONFIG.database_path) as conn:
        settings = db.get_app_settings(conn)
        if not settings:
            return None
        
        # We need the model map for resolve_providers
        # For simplicity, we can load all setting models
        # Or just use the defaults from the profile
        from app.config import get_profile_defaults
        defaults = get_profile_defaults(settings["profile"])
        
        providers = resolve_providers(settings["profile"], defaults)
        
        if subsystem == "memory":
            # For now, memory uses the fast LLM
            return providers.get("llm_fast")
        if subsystem == "text_chat":
            return providers.get("llm_fast") if model_type == "fast" else providers.get("llm_thinking")
            
        return providers.get(subsystem)
