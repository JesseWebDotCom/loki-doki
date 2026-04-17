"""Resolve latest ZIM file URLs from the Kiwix download index.

Fetches the Kiwix directory listing for a given source to find the
most recent ZIM filename and its size. Used by the download manager
to construct download URLs and by the admin panel to detect updates.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import httpx

from .catalog import ZIM_CATALOG, get_source, get_variant
from .models import ArchiveState

log = logging.getLogger(__name__)

KIWIX_BASE = "https://download.kiwix.org/zim"
# Matches ZIM filenames with date: name_lang_variant_YYYY-MM.zim
_ZIM_FILENAME_RE = re.compile(
    r'href="([^"]+?_(\d{4}-\d{2})\.zim)"',
)
_SIZE_RE = re.compile(r'(\d+(?:\.\d+)?)\s*([KMGT])')
_MULTIPLIERS = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}

USER_AGENT = "LokiDoki/0.1 (offline-knowledge-manager)"


@dataclass
class ZimFileInfo:
    """Resolved ZIM file metadata."""

    source_id: str
    filename: str
    url: str
    date: str           # e.g. "2025-03"
    size_bytes: int      # approximate from directory listing


async def resolve_latest_zim(
    source_id: str,
    variant_key: str,
    language: str = "en",
) -> ZimFileInfo | None:
    """Fetch the Kiwix directory listing and find the latest ZIM.

    Returns None if the source/variant can't be resolved or the
    network request fails.
    """
    source = get_source(source_id)
    if not source:
        log.warning("Unknown source_id: %s", source_id)
        return None

    variant = get_variant(source, variant_key)
    if not variant:
        log.warning("Unknown variant %s for source %s", variant_key, source_id)
        return None

    dir_url = f"{KIWIX_BASE}/{source.kiwix_dir}/"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                dir_url,
                headers={"User-Agent": USER_AGENT},
                follow_redirects=True,
            )
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        log.warning("Failed to fetch Kiwix directory %s: %s", dir_url, exc)
        return None

    html = resp.text
    slug = variant.url_slug

    # Find all ZIM files matching the variant slug + language
    candidates: list[tuple[str, str]] = []  # (filename, date)
    for match in _ZIM_FILENAME_RE.finditer(html):
        filename = match.group(1)
        date = match.group(2)
        # Filter by language and variant slug
        if f"_{language}_" in filename and slug in filename:
            candidates.append((filename, date))

    if not candidates:
        log.info("No ZIM files found for %s/%s/%s", source_id, variant_key, language)
        return None

    # Pick the most recent by date string (YYYY-MM sorts lexicographically)
    candidates.sort(key=lambda x: x[1], reverse=True)
    best_filename, best_date = candidates[0]
    download_url = f"{dir_url}{best_filename}"

    # Estimate size from the variant catalog (directory listings don't
    # always show exact sizes reliably)
    approx_bytes = int(variant.approx_size_gb * 1_073_741_824)

    return ZimFileInfo(
        source_id=source_id,
        filename=best_filename,
        url=download_url,
        date=best_date,
        size_bytes=approx_bytes,
    )


async def check_for_updates(
    states: list[ArchiveState],
) -> list[tuple[str, str, str]]:
    """Compare installed ZIM dates against latest available.

    Returns a list of (source_id, installed_date, latest_date) for
    archives where a newer version exists.
    """
    updates: list[tuple[str, str, str]] = []
    for state in states:
        if not state.download_complete:
            continue
        info = await resolve_latest_zim(
            state.source_id, state.variant, state.language,
        )
        if info and info.date > state.zim_date:
            updates.append((state.source_id, state.zim_date, info.date))
    return updates
