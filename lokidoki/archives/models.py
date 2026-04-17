"""Runtime data models for archive configuration and state.

ArchiveConfig is what the admin chooses (which archives, which variants,
where to store them). ArchiveState is what's actually on disk (file
paths, sizes, download timestamps). ArchiveStatus combines both for
the admin panel display.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ArchiveConfig:
    """Admin-configured settings for one archive source."""

    source_id: str
    enabled: bool = False
    variant: str = ""               # variant key from catalog
    language: str = "en"
    storage_path: str | None = None  # None = default (data/archives/)
    topics: list[str] = field(default_factory=list)  # Stack Exchange only


@dataclass
class ArchiveState:
    """On-disk state for one downloaded archive."""

    source_id: str
    variant: str
    language: str
    file_path: str              # absolute path to the .zim file
    file_size_bytes: int
    zim_date: str               # date from ZIM filename, e.g. "2025-03"
    download_complete: bool
    downloaded_at: str | None = None   # ISO timestamp


@dataclass
class ArchiveStatus:
    """Combined config + state for admin panel display."""

    source_id: str
    label: str
    description: str
    category: str
    favicon_path: str | None    # local path to cached favicon
    config: ArchiveConfig | None
    state: ArchiveState | None
    update_available: bool = False
    latest_date: str | None = None
