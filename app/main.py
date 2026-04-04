"""LokiDoki - Core Application Service."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import db
from app.deps import APP_CONFIG, ensure_database_ready, connection_scope
from app.api import auth, admin, admin_voices, chat, analysis, vision, voice, skills, memory, system, character, lab, settings, projects
from app.api.utils import UI_SHELL_CACHE_HEADERS, CachedAssetStaticFiles
from app.subsystems.voice import wakeword_runtime_status
from app.subsystems.character import character_service
from app.providers.piper_service import piper_status


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Initialize application subsystems and hardware providers."""
    ensure_database_ready()
    
    # Initialize character subsystem
    with connection_scope() as connection:
        character_service.initialize(connection, APP_CONFIG)
        
    # Initialize wakeword engine
    from app.subsystems.voice.wakeword import WakewordSessionManager
    app.state.wakeword_sessions = WakewordSessionManager()
    
    yield
    
    # Cleanup
    if hasattr(app.state, "wakeword_sessions"):
        pass # WakewordSessionManager doesn't need explicit shutdown currently


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="LokiDoki",
        description="Core Application Service",
        version="1.0.0",
        lifespan=lifespan,
    )

    # Middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # API Routes
    app.include_router(auth.router, prefix="/api")
    app.include_router(admin.router, prefix="/api")
    app.include_router(admin_voices.router, prefix="/api")
    app.include_router(chat.router, prefix="/api")
    app.include_router(chat.compat_router, prefix="/api")
    app.include_router(analysis.router, prefix="/api")
    app.include_router(vision.router, prefix="/api")
    app.include_router(voice.router, prefix="/api")
    app.include_router(skills.router, prefix="/api")
    app.include_router(memory.router, prefix="/api")
    app.include_router(system.router, prefix="/api")
    app.include_router(settings.router, prefix="/api")
    app.include_router(character.router, prefix="/api")
    app.include_router(lab.router, prefix="/api")
    app.include_router(projects.router, prefix="/api")

    # UI Static Serving
    dist_dir = APP_CONFIG.ui_dist_dir
    if dist_dir.exists():
        assets_dir = dist_dir / "assets"
        if assets_dir.exists():
            app.mount("/assets", CachedAssetStaticFiles(directory=str(assets_dir)), name="assets")

        @app.get("/{full_path:path}")
        async def spa(full_path: str) -> FileResponse:
            # Exclude API paths from SPA catch-all to let them 404 properly (or match routers accurately)
            if full_path.startswith("api/") or full_path.startswith("/api/"):
                raise HTTPException(status_code=404, detail="API endpoint not found.")
                
            candidate = dist_dir / full_path
            if full_path and candidate.exists() and candidate.is_file():
                return FileResponse(candidate, headers=UI_SHELL_CACHE_HEADERS)
            return FileResponse(dist_dir / "index.html", headers=UI_SHELL_CACHE_HEADERS)

    return app


APP = create_app()
app = APP # For uvicorn
