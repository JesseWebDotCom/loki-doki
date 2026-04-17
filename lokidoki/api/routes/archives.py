"""Archive management routes — admin-only CRUD + storage reporting."""
from __future__ import annotations

import shutil
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from lokidoki.archives import catalog, store
from lokidoki.archives.models import ArchiveConfig, ArchiveStatus

router = APIRouter()


# ── Request / response models ───────────────────────────────────

class ConfigureArchiveRequest(BaseModel):
    enabled: bool = True
    variant: str = ""
    language: str = "en"
    storage_path: str | None = None
    topics: list[str] = Field(default_factory=list)


class StorageLocation(BaseModel):
    path: str
    label: str
    total_bytes: int
    free_bytes: int
    is_default: bool


# ── Catalog ─────────────────────────────────────────────────────

@router.get("/catalog")
async def get_catalog(_: User = Depends(require_admin)):
    """Return the full ZIM source catalog with favicon paths."""
    favicon_base = store.favicon_dir()
    result = []
    for source in catalog.ZIM_CATALOG:
        favicon_path = favicon_base / f"{source.source_id}.ico"
        entry = {
            "source_id": source.source_id,
            "label": source.label,
            "description": source.description,
            "category": source.category,
            "favicon_exists": favicon_path.exists(),
            "variants": [asdict(v) for v in source.variants],
            "default_variant": source.default_variant,
            "languages": source.languages,
            "default_language": source.default_language,
            "is_topic_picker": source.is_topic_picker,
            "available_topics": [asdict(t) for t in source.available_topics],
        }
        result.append(entry)
    return {"catalog": result}


# ── Status ──────────────────────────────────────────────────────

@router.get("/status")
async def get_status(_: User = Depends(require_admin)):
    """Return configured archives with on-disk state."""
    configs = store.load_configs()
    states = store.load_states()
    favicon_base = store.favicon_dir()

    state_map = {s.source_id: s for s in states}
    config_map = {c.source_id: c for c in configs}

    statuses: list[dict] = []
    for source in catalog.ZIM_CATALOG:
        cfg = config_map.get(source.source_id)
        st = state_map.get(source.source_id)
        favicon_path = favicon_base / f"{source.source_id}.ico"
        status = ArchiveStatus(
            source_id=source.source_id,
            label=source.label,
            description=source.description,
            category=source.category,
            favicon_path=str(favicon_path) if favicon_path.exists() else None,
            config=cfg,
            state=st,
        )
        statuses.append(asdict(status))
    return {"archives": statuses}


# ── Configure ───────────────────────────────────────────────────

@router.put("/{source_id}")
async def configure_archive(
    source_id: str,
    body: ConfigureArchiveRequest,
    _: User = Depends(require_admin),
):
    """Enable/configure an archive source."""
    source = catalog.get_source(source_id)
    if not source:
        raise HTTPException(404, f"Unknown archive source: {source_id}")

    variant_key = body.variant or source.default_variant
    if not catalog.get_variant(source, variant_key):
        raise HTTPException(400, f"Unknown variant: {variant_key}")

    config = ArchiveConfig(
        source_id=source_id,
        enabled=body.enabled,
        variant=variant_key,
        language=body.language,
        storage_path=body.storage_path,
        topics=body.topics,
    )
    store.upsert_config(config)
    return {"ok": True, "config": asdict(config)}


@router.delete("/{source_id}")
async def remove_archive(
    source_id: str,
    _: User = Depends(require_admin),
):
    """Remove archive config and delete the ZIM file if present."""
    state = store.get_state(source_id)
    if state and state.file_path:
        zim_path = Path(state.file_path)
        if zim_path.exists():
            zim_path.unlink()

    store.remove_config(source_id)
    store.remove_state(source_id)

    from lokidoki.archives.search import reload_search_engine
    reload_search_engine()

    return {"ok": True}


# ── Storage reporting ───────────────────────────────────────────

@router.get("/storage")
async def get_storage(_: User = Depends(require_admin)):
    """Per-archive and aggregate storage report with projections."""
    states = store.load_states()
    configs = store.load_configs()

    # Per-archive sizes
    archive_sizes: list[dict] = []
    total_used = 0
    for st in states:
        if st.download_complete:
            archive_sizes.append({
                "source_id": st.source_id,
                "file_size_bytes": st.file_size_bytes,
                "file_path": st.file_path,
            })
            total_used += st.file_size_bytes

    # Default location disk info
    default_dir = store.default_archive_dir()
    default_dir.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(default_dir)

    # Projection: sum of configured-but-not-downloaded archives
    pending_bytes = 0
    downloaded_ids = {s.source_id for s in states if s.download_complete}
    for cfg in configs:
        if cfg.source_id not in downloaded_ids and cfg.enabled:
            source = catalog.get_source(cfg.source_id)
            if source:
                variant = catalog.get_variant(source, cfg.variant)
                if variant:
                    pending_bytes += int(variant.approx_size_gb * 1_073_741_824)

    return {
        "archives": archive_sizes,
        "total_used_bytes": total_used,
        "pending_download_bytes": pending_bytes,
        "default_location": {
            "path": str(default_dir),
            "total_bytes": disk.total,
            "free_bytes": disk.free,
        },
        "projected_free_bytes": disk.free - pending_bytes,
        "low_space_warning": (disk.free - pending_bytes) < 2_147_483_648,  # <2GB
    }


@router.get("/storage/locations")
async def get_storage_locations(_: User = Depends(require_admin)):
    """List available storage locations with free space."""
    default_dir = store.default_archive_dir()
    default_dir.mkdir(parents=True, exist_ok=True)
    default_disk = shutil.disk_usage(default_dir)

    locations = [
        StorageLocation(
            path=str(default_dir),
            label="Default (app data)",
            total_bytes=default_disk.total,
            free_bytes=default_disk.free,
            is_default=True,
        ),
    ]

    # Add any custom paths from existing configs
    configs = store.load_configs()
    seen_paths = {str(default_dir)}
    for cfg in configs:
        if cfg.storage_path and cfg.storage_path not in seen_paths:
            p = Path(cfg.storage_path)
            if p.exists():
                disk = shutil.disk_usage(p)
                locations.append(StorageLocation(
                    path=cfg.storage_path,
                    label=str(p),
                    total_bytes=disk.total,
                    free_bytes=disk.free,
                    is_default=False,
                ))
                seen_paths.add(cfg.storage_path)

    return {"locations": [loc.model_dump() for loc in locations]}


# ── Downloads ───────────────────────────────────────────────────

@router.post("/{source_id}/download")
async def start_download(
    source_id: str,
    _: User = Depends(require_admin),
):
    """Start downloading the configured ZIM archive."""
    source = catalog.get_source(source_id)
    if not source:
        raise HTTPException(404, f"Unknown archive source: {source_id}")

    config = store.get_config(source_id)
    if not config:
        raise HTTPException(400, f"Archive {source_id} not configured. Configure it first via PUT.")

    from lokidoki.archives.download_manager import get_download_manager
    from dataclasses import asdict as _asdict

    mgr = get_download_manager()
    dest_dir = Path(config.storage_path) if config.storage_path else None
    progress = await mgr.start_download(
        source_id, config.variant, config.language, dest_dir,
    )
    if progress.status == "error":
        raise HTTPException(400, progress.error)
    return {"ok": True, "progress": _asdict(progress)}


@router.post("/{source_id}/cancel")
async def cancel_download(
    source_id: str,
    _: User = Depends(require_admin),
):
    """Cancel an in-progress download."""
    from lokidoki.archives.download_manager import get_download_manager

    mgr = get_download_manager()
    cancelled = await mgr.cancel_download(source_id)
    if not cancelled:
        raise HTTPException(404, "No active download for this archive")
    return {"ok": True}


@router.get("/{source_id}/progress")
async def download_progress(source_id: str):
    """Get current download progress (poll endpoint)."""
    from lokidoki.archives.download_manager import get_download_manager
    from dataclasses import asdict as _asdict

    mgr = get_download_manager()
    progress = mgr.get_progress(source_id)
    if not progress:
        # Check if it's already downloaded
        state = store.get_state(source_id)
        if state and state.download_complete:
            return {"status": "complete", "source_id": source_id}
        return {"status": "idle", "source_id": source_id}
    return _asdict(progress)


@router.post("/import")
async def import_zim(
    _: User = Depends(require_admin),
    file_path: str = "",
    source_id: str = "custom",
):
    """Import a custom ZIM file from a local path."""
    p = Path(file_path)
    if not p.exists() or not p.suffix == ".zim":
        raise HTTPException(400, "File does not exist or is not a .zim file")

    state = ArchiveState(
        source_id=source_id,
        variant="custom",
        language="en",
        file_path=str(p.resolve()),
        file_size_bytes=p.stat().st_size,
        zim_date="custom",
        download_complete=True,
    )
    store.upsert_state(state)

    config = ArchiveConfig(
        source_id=source_id,
        enabled=True,
        variant="custom",
        storage_path=str(p.parent),
    )
    store.upsert_config(config)
    return {"ok": True, "source_id": source_id, "size_bytes": state.file_size_bytes}


# ── Favicon serving ─────────────────────────────────────────────

@router.get("/favicon/{source_id}")
async def get_favicon(source_id: str):
    """Serve a cached archive favicon. Fetches on demand if not cached."""
    import httpx as _httpx

    favicon_dir = store.favicon_dir()
    favicon_dir.mkdir(parents=True, exist_ok=True)
    favicon_path = favicon_dir / f"{source_id}.ico"

    # Fetch on demand if not cached (bootstrap may not have run)
    if not favicon_path.exists():
        source = catalog.get_source(source_id)
        if not source:
            raise HTTPException(404, "Unknown source")
        try:
            async with _httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(source.favicon_url, follow_redirects=True)
                if resp.status_code == 200 and len(resp.content) > 0:
                    favicon_path.write_bytes(resp.content)
        except Exception:
            raise HTTPException(404, "Favicon not available")

    if not favicon_path.exists():
        raise HTTPException(404, "Favicon not found")
    return FileResponse(favicon_path, media_type="image/x-icon")


# ── Search ──────────────────────────────────────────────────────

@router.get("/search")
async def search_archives(
    q: str = "",
    sources: str = "",
    limit: int = 5,
):
    """Search across installed ZIM archives. No auth — used by search page."""
    if not q:
        raise HTTPException(400, "Query parameter 'q' is required")

    from lokidoki.archives.search import get_search_engine

    engine = get_search_engine()
    if engine is None or not engine.loaded_sources:
        return {"results": [], "message": "No archives loaded"}

    source_list = [s.strip() for s in sources.split(",") if s.strip()] or None
    results = await engine.search(q, sources=source_list, max_results=limit)
    return {
        "results": [
            {
                "source_id": r.source_id,
                "title": r.title,
                "path": r.path,
                "snippet": r.snippet,
                "url": r.url,
                "source_label": r.source_label,
            }
            for r in results
        ],
    }


# ── Article content (for browser) ──────────────────────────────

@router.get("/article/{source_id}/{path:path}")
async def get_article(source_id: str, path: str):
    """Fetch article as markdown for the browser view."""
    from lokidoki.archives.search import get_search_engine
    from lokidoki.archives.html_to_markdown import html_to_markdown, extract_toc

    engine = get_search_engine()
    if engine is None:
        raise HTTPException(503, "No archives loaded")

    # Get raw HTML from ZIM
    html = await engine.get_article_html(source_id, path)
    if html is None:
        raise HTTPException(404, "Article not found")

    # Convert to markdown
    markdown = html_to_markdown(html)
    toc = extract_toc(markdown)

    # Get metadata
    article = await engine.get_article(source_id, path)
    title = article.title if article else path
    url = article.url if article else ""
    source_label = article.source_label if article else source_id

    return {
        "source_id": source_id,
        "title": title,
        "path": path,
        "markdown": markdown,
        "toc": toc,
        "url": url,
        "source_label": source_label,
    }


@router.get("/media/{source_id}/{path:path}")
async def get_media(source_id: str, path: str):
    """Serve binary content (images, etc.) from a ZIM archive."""
    from fastapi.responses import Response
    from lokidoki.archives.search import get_search_engine

    engine = get_search_engine()
    if engine is None:
        raise HTTPException(503, "No archives loaded")

    data = await engine.get_media(source_id, path)
    if data is None:
        raise HTTPException(404, "Media not found")

    # Guess content type from extension
    import mimetypes
    content_type, _ = mimetypes.guess_type(path)
    return Response(content=data, media_type=content_type or "application/octet-stream")


# ── Update check ────────────────────────────────────────────────

@router.post("/check-updates")
async def check_updates(_: User = Depends(require_admin)):
    """Check installed archives for newer versions."""
    from lokidoki.archives.resolver import check_for_updates

    states = store.load_states()
    updates = await check_for_updates(states)
    return {
        "updates": [
            {"source_id": sid, "installed_date": old, "latest_date": new}
            for sid, old, new in updates
        ],
    }
