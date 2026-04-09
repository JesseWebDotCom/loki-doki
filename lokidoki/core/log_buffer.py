"""In-memory ring buffer log handler for the dev/admin log viewer.

A single global ``LogBuffer`` is installed at app startup. Any module
that uses ``logging.getLogger(...)`` automatically feeds into it. The
``/api/v1/logs`` route reads from it.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from threading import Lock
from typing import Deque, List, Optional, Tuple


class LogBuffer(logging.Handler):
    """Bounded ring buffer of recent log records, thread-safe."""

    def __init__(self, capacity: int = 2000) -> None:
        super().__init__()
        self._records: Deque[dict] = deque(maxlen=capacity)
        self._lock = Lock()
        self._seq = 0
        # (loop, queue) pairs — one per active SSE subscriber.
        self._subscribers: List[Tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
        self.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
        except Exception:
            msg = record.getMessage()
        with self._lock:
            self._seq += 1
            entry = {
                "id": self._seq,
                "ts": record.created,
                "level": record.levelname,
                "logger": record.name,
                "message": msg,
            }
            self._records.append(entry)
            subs = list(self._subscribers)
        # Fan out to SSE subscribers without holding the lock. emit() may
        # be called from any thread, so we hop into each subscriber's
        # event loop via call_soon_threadsafe.
        for loop, queue in subs:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, entry)
            except RuntimeError:
                # loop is closed; subscriber will be reaped on next subscribe call
                pass

    def snapshot(self, since_id: int = 0, limit: int = 500) -> List[dict]:
        with self._lock:
            records = [r for r in self._records if r["id"] > since_id]
        return records[-limit:]

    def subscribe(self) -> asyncio.Queue:
        """Register a new SSE subscriber. Returns its queue."""
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        with self._lock:
            self._subscribers.append((loop, queue))
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers = [(l, q) for (l, q) in self._subscribers if q is not queue]


_buffer: Optional[LogBuffer] = None


def install(level: int = logging.INFO, capacity: int = 2000) -> LogBuffer:
    """Attach the global LogBuffer to the root logger. Idempotent."""
    global _buffer
    if _buffer is not None:
        return _buffer
    _buffer = LogBuffer(capacity=capacity)
    _buffer.setLevel(level)
    root = logging.getLogger()
    if root.level > level or root.level == logging.NOTSET:
        root.setLevel(level)
    root.addHandler(_buffer)
    # httpx logs every HTTP request at INFO — with the frontend polling
    # system-info every 15 s that produces ~8 lines per cycle. Suppress.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    return _buffer


def get_buffer() -> Optional[LogBuffer]:
    return _buffer
