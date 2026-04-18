"""Maps routes — region catalog and tile serving.

This is a stub for Chunk 1 of the offline-maps plan. Later chunks
populate the regions list from an on-disk catalog and add endpoints
for tile bytes, geocoding, and routing.
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/regions")
async def list_regions() -> list[dict]:
    """Return installed map regions. Empty until Chunk 2 lands."""
    return []
