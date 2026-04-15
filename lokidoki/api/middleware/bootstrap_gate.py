"""Bootstrap gate middleware.

When the ``users`` table is empty, every request that isn't part of the
bootstrap flow itself returns ``409 {"error": "needs_bootstrap"}`` so
the frontend can route the visitor to the wizard. This is enforced
centrally rather than per-route to guarantee no endpoint accidentally
runs against an empty user table.
"""
from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from lokidoki.core.memory_singleton import get_memory_provider

# Path prefixes that are always allowed even when no users exist.
_ALLOW_PREFIXES = (
    "/api/v1/auth/bootstrap",
    "/api/v1/auth/me",          # returns 409 itself for the frontend probe
    "/api/v1/bootstrap/status",
    "/bootstrap",
    "/static",
    "/assets",
)

# Exact paths that are always allowed.
# ``/api/health`` is the handoff probe Layer 1 polls while spawning
# FastAPI — it must stay reachable before any user exists.
_ALLOW_EXACT = {"/", "/favicon.ico", "/api/health"}


def _is_allowed(path: str) -> bool:
    if path in _ALLOW_EXACT:
        return True
    for p in _ALLOW_PREFIXES:
        if path.startswith(p):
            return True
    # SPA routes for the wizard / login also need to load.
    if path.startswith("/wizard") or path.startswith("/login"):
        return True
    return False


class BootstrapGateMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if _is_allowed(path):
            return await call_next(request)
        # Only gate API routes; let static/SPA fall through.
        if not path.startswith("/api/"):
            return await call_next(request)
        memory = await get_memory_provider()
        if await memory.count_users() == 0:
            return JSONResponse(
                status_code=409, content={"error": "needs_bootstrap"}
            )
        return await call_next(request)
