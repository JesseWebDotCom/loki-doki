"""Favicon resolver with ZIM illustration + apple-touch-icon + library.kiwix.org.

Kiwix ZIM files embed a square PNG illustration as standard metadata —
those are purpose-made, higher quality than scraped favicons. When the
archive is downloaded we extract directly from the ZIM. When it is not,
we fall back to apple-touch-icon PNGs (typically 180px) or the vanilla
favicon.ico. Results are cached under ``favicon_dir``.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import httpx

from lokidoki.archives import store
from lokidoki.archives.catalog import ZimSource

log = logging.getLogger(__name__)

FETCH_TIMEOUT_S: float = 5.0

# Preferred ZIM illustration size — Kiwix ZIMs typically offer 48 and
# sometimes 96. Try 96 first for higher quality, fall back to 48.
ZIM_ILLUSTRATION_SIZES: tuple[int, ...] = (96, 48)


async def resolve_and_cache_favicon(
    source: ZimSource,
) -> tuple[Optional[Path], str]:
    """Return the path to a cached favicon + its media type.

    Tries cache → ZIM illustration → apple-touch-icon → favicon.ico
    in order. On success writes the bytes to ``favicon_dir`` so the next
    request is a zero-network read.

    Returns ``(None, "")`` when every source fails; callers should 404.
    """
    favicon_dir = store.favicon_dir()
    favicon_dir.mkdir(parents=True, exist_ok=True)

    # 1. Cache hit — prefer PNG (newer, higher-quality); fall through
    # on suspiciously small files (< 400 bytes) so 1×1 placeholders or
    # truncated fetches get replaced automatically.
    _MIN_GOOD_BYTES = 400
    for suffix, media in (("png", "image/png"), ("ico", "image/x-icon")):
        candidate = favicon_dir / f"{source.source_id}.{suffix}"
        if candidate.exists() and candidate.stat().st_size >= _MIN_GOOD_BYTES:
            return candidate, media

    # 2. ZIM illustration.
    png_bytes = _extract_zim_illustration(source.source_id)
    if png_bytes:
        path = favicon_dir / f"{source.source_id}.png"
        path.write_bytes(png_bytes)
        log.debug("favicon %s: ZIM illustration (%d bytes)", source.source_id, len(png_bytes))
        return path, "image/png"

    # 3. apple-touch-icon — 180px PNG, common web-manifest convention.
    touch = await _fetch_apple_touch_icon(source.favicon_url)
    if touch:
        path = favicon_dir / f"{source.source_id}.png"
        path.write_bytes(touch)
        log.debug("favicon %s: apple-touch-icon (%d bytes)", source.source_id, len(touch))
        return path, "image/png"

    # 4. Last resort — the original ``favicon.ico`` URL from the catalog.
    ico = await _fetch_bytes(source.favicon_url)
    if ico:
        path = favicon_dir / f"{source.source_id}.ico"
        path.write_bytes(ico)
        log.debug("favicon %s: favicon.ico (%d bytes)", source.source_id, len(ico))
        return path, "image/x-icon"

    return None, ""


def _extract_zim_illustration(source_id: str) -> Optional[bytes]:
    """Pull the embedded illustration PNG from a downloaded ZIM.

    Returns ``None`` if the archive isn't downloaded, the ZIM has no
    illustration at any preferred size, or libzim surfaces an error.
    """
    from lokidoki.archives.search import get_search_engine

    engine = get_search_engine()
    if engine is None:
        return None
    reader = engine._readers.get(source_id)  # noqa: SLF001 — single-callsite helper
    if reader is None:
        return None

    for size in ZIM_ILLUSTRATION_SIZES:
        try:
            if not reader.has_illustration(size):
                continue
            item = reader.get_illustration_item(size)
            return bytes(item.content)
        except Exception as exc:  # noqa: BLE001 — libzim raises varied errors
            log.debug("ZIM %s illustration at %dpx failed: %s", source_id, size, exc)
            continue
    return None


async def _fetch_apple_touch_icon(favicon_url: str) -> Optional[bytes]:
    """Probe the archive's site origin for ``/apple-touch-icon.png``.

    Derives the origin from ``favicon_url`` (the canonical homepage in
    the catalog) — if the site publishes an apple-touch-icon the
    returned PNG is typically 180x180, crisp on retina displays.
    """
    origin = _origin_of(favicon_url)
    if not origin:
        return None
    for candidate in (
        f"{origin}/apple-touch-icon.png",
        f"{origin}/apple-touch-icon-precomposed.png",
    ):
        data = await _fetch_bytes(candidate)
        if data:
            return data
    return None


async def _fetch_bytes(url: str) -> Optional[bytes]:
    """GET ``url`` and return body on 200, otherwise ``None``."""
    if not url:
        return None
    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_S, follow_redirects=True) as client:
            resp = await client.get(url)
            if resp.status_code == 200 and resp.content:
                return resp.content
    except Exception as exc:  # noqa: BLE001 — network transport errors
        log.debug("favicon fetch failed for %s: %s", url, exc)
    return None


def _origin_of(url: str) -> str:
    """Extract the ``scheme://host`` origin from a full URL. Empty on failure."""
    from urllib.parse import urlparse

    try:
        parsed = urlparse(url)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    except Exception:  # noqa: BLE001
        pass
    return ""
