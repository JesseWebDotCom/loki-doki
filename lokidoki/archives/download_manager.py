"""Background ZIM download manager with progress tracking.

Downloads are asyncio tasks that stream ZIM files to disk with
progress updates. The admin panel polls or SSE-streams progress
for active downloads.
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncGenerator

import httpx

from .resolver import resolve_latest_zim
from . import store
from .models import ArchiveState

log = logging.getLogger(__name__)

CHUNK_SIZE = 1024 * 1024  # 1 MB
MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB
USER_AGENT = "LokiDoki/0.1 (offline-knowledge-manager)"


@dataclass
class DownloadProgress:
    """Snapshot of a download's progress."""

    source_id: str
    status: str             # "resolving", "downloading", "complete", "error", "cancelled"
    bytes_downloaded: int = 0
    bytes_total: int = 0
    percent: float = 0.0
    speed_bps: float = 0.0
    error: str | None = None


@dataclass
class _DownloadTask:
    """Internal tracking for an active download."""

    source_id: str
    task: asyncio.Task
    progress: DownloadProgress
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)


class DownloadManager:
    """Manages concurrent ZIM file downloads."""

    def __init__(self) -> None:
        self._active: dict[str, _DownloadTask] = {}

    async def start_download(
        self,
        source_id: str,
        variant: str,
        language: str,
        dest_dir: Path | None = None,
    ) -> DownloadProgress:
        """Start downloading a ZIM file. Returns initial progress."""
        if source_id in self._active:
            return self._active[source_id].progress

        dest_dir = dest_dir or store.default_archive_dir()
        dest_dir.mkdir(parents=True, exist_ok=True)

        # Check disk space
        disk = shutil.disk_usage(dest_dir)
        if disk.free < MIN_FREE_BYTES:
            return DownloadProgress(
                source_id=source_id,
                status="error",
                error=f"Insufficient disk space: {disk.free / 1e9:.1f} GB free, need at least 2 GB",
            )

        progress = DownloadProgress(source_id=source_id, status="resolving")
        cancel_event = asyncio.Event()
        task = asyncio.create_task(
            self._download_worker(source_id, variant, language, dest_dir, progress, cancel_event)
        )
        self._active[source_id] = _DownloadTask(
            source_id=source_id,
            task=task,
            progress=progress,
            cancel_event=cancel_event,
        )
        return progress

    async def cancel_download(self, source_id: str) -> bool:
        """Cancel an active download. Returns True if cancelled."""
        dt = self._active.get(source_id)
        if not dt:
            return False
        dt.cancel_event.set()
        dt.progress.status = "cancelled"
        dt.task.cancel()
        self._active.pop(source_id, None)
        return True

    def get_progress(self, source_id: str) -> DownloadProgress | None:
        """Get current progress for an active download."""
        dt = self._active.get(source_id)
        return dt.progress if dt else None

    async def progress_stream(
        self, source_id: str, interval: float = 0.5,
    ) -> AsyncGenerator[DownloadProgress, None]:
        """Yield progress updates until download completes or is cancelled."""
        while True:
            progress = self.get_progress(source_id)
            if progress is None:
                return
            yield progress
            if progress.status in ("complete", "error", "cancelled"):
                return
            await asyncio.sleep(interval)

    async def _download_worker(
        self,
        source_id: str,
        variant: str,
        language: str,
        dest_dir: Path,
        progress: DownloadProgress,
        cancel_event: asyncio.Event,
    ) -> None:
        """Background worker that resolves URL and streams the download."""
        try:
            # Resolve latest ZIM URL
            info = await resolve_latest_zim(source_id, variant, language)
            if not info:
                progress.status = "error"
                progress.error = f"Could not resolve ZIM file for {source_id}/{variant}/{language}"
                return

            progress.status = "downloading"
            progress.bytes_total = info.size_bytes

            dest_path = dest_dir / info.filename
            part_path = dest_path.with_suffix(".zim.part")

            start_time = time.monotonic()
            downloaded = 0

            async with httpx.AsyncClient(
                timeout=httpx.Timeout(30.0, read=300.0),
                follow_redirects=True,
            ) as client:
                async with client.stream(
                    "GET", info.url,
                    headers={"User-Agent": USER_AGENT},
                ) as resp:
                    resp.raise_for_status()

                    # Update total from Content-Length if available
                    content_length = resp.headers.get("content-length")
                    if content_length:
                        progress.bytes_total = int(content_length)

                    with open(part_path, "wb") as f:
                        async for chunk in resp.aiter_bytes(CHUNK_SIZE):
                            if cancel_event.is_set():
                                progress.status = "cancelled"
                                _cleanup_part(part_path)
                                return

                            f.write(chunk)
                            downloaded += len(chunk)

                            elapsed = time.monotonic() - start_time
                            progress.bytes_downloaded = downloaded
                            progress.speed_bps = downloaded / elapsed if elapsed > 0 else 0
                            if progress.bytes_total > 0:
                                progress.percent = (downloaded / progress.bytes_total) * 100

            # Atomic rename
            if dest_path.exists():
                dest_path.unlink()
            part_path.rename(dest_path)

            # Persist state
            state = ArchiveState(
                source_id=source_id,
                variant=variant,
                language=language,
                file_path=str(dest_path),
                file_size_bytes=downloaded,
                zim_date=info.date,
                download_complete=True,
                downloaded_at=_iso_now(),
            )
            store.upsert_state(state)

            # Reload search engine so new archive is immediately searchable
            from .search import reload_search_engine
            reload_search_engine()

            progress.status = "complete"
            progress.percent = 100.0
            progress.bytes_downloaded = downloaded

        except asyncio.CancelledError:
            progress.status = "cancelled"
            _cleanup_part(dest_dir / f"{source_id}.zim.part")
        except Exception as exc:
            log.exception("Download failed for %s", source_id)
            progress.status = "error"
            progress.error = str(exc)
        finally:
            self._active.pop(source_id, None)


def _cleanup_part(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# Module-level singleton
_manager: DownloadManager | None = None


def get_download_manager() -> DownloadManager:
    """Return the singleton download manager."""
    global _manager
    if _manager is None:
        _manager = DownloadManager()
    return _manager
