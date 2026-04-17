"""Download favicons for offline archive sources at bootstrap time.

Icons are cached at ``.lokidoki/archives/favicons/{source_id}.ico`` so
the admin panel can display them without storing third-party assets in
the repo. Failures are non-fatal — a missing icon just shows a
placeholder in the UI.
"""
from __future__ import annotations

import logging
from pathlib import Path

from ..context import StepContext
from ..events import StepLog

_log = logging.getLogger(__name__)
_STEP_ID = "fetch-archive-icons"


async def ensure_archive_favicons(ctx: StepContext) -> None:
    """Fetch favicons for every entry in the ZIM catalog."""
    from lokidoki.archives.catalog import ZIM_CATALOG

    favicon_dir = ctx.data_dir / "archives" / "favicons"
    favicon_dir.mkdir(parents=True, exist_ok=True)

    fetched = 0
    skipped = 0
    failed = 0

    for source in ZIM_CATALOG:
        dest = favicon_dir / f"{source.source_id}.ico"
        if dest.exists():
            skipped += 1
            continue
        try:
            await ctx.download(source.favicon_url, dest, _STEP_ID)
            fetched += 1
        except Exception as exc:
            failed += 1
            ctx.emit(StepLog(
                step_id=_STEP_ID,
                line=f"warn: {source.source_id} icon failed: {exc}",
            ))

    ctx.emit(StepLog(
        step_id=_STEP_ID,
        line=f"favicons: {fetched} fetched, {skipped} cached, {failed} failed",
    ))
