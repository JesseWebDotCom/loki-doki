"""Recent backend log records — admin-only viewer for DevPage / Admin."""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from lokidoki.api.routes.auth import current_user, User
from lokidoki.core.log_buffer import get_buffer

router = APIRouter()


@router.get("")
async def list_logs(
    since_id: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=2000),
    user: User = Depends(current_user),
):
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin_only")
    buf = get_buffer()
    if buf is None:
        return {"records": [], "installed": False}
    return {"records": buf.snapshot(since_id=since_id, limit=limit), "installed": True}


@router.get("/stream")
async def stream_logs(
    since_id: int = Query(0, ge=0),
    user: User = Depends(current_user),
):
    """SSE stream: replay recent buffer once, then push new records live."""
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin_only")
    buf = get_buffer()
    if buf is None:
        raise HTTPException(status_code=503, detail="log_buffer_not_installed")

    async def event_stream():
        queue = buf.subscribe()
        try:
            # Replay backlog so the client doesn't miss anything between
            # subscribe time and the first live record.
            for r in buf.snapshot(since_id=since_id, limit=2000):
                yield f"data: {json.dumps(r)}\n\n"
            while True:
                try:
                    rec = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(rec)}\n\n"
                except asyncio.TimeoutError:
                    # Heartbeat keeps proxies / browsers from closing the
                    # connection on idle.
                    yield ": keepalive\n\n"
        finally:
            buf.unsubscribe(queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
