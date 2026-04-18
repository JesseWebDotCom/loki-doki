"""Online-only Nominatim shim — used when no installed region covers the viewport.

The FTS backend is always preferred. This module exists so the
``/geocode`` route can surface a remote result when the user pans
somewhere no downloaded region reaches — the frontend then shows the
"Using online search for this area" chip from the chunk spec.

Requests time out quickly (3 s) so an offline Pi never hangs on a
dead fetch — we surface an empty list and let the frontend render the
offline banner.
"""
from __future__ import annotations

import logging

import httpx

from . import GeocodeResult

log = logging.getLogger(__name__)

_NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
_USER_AGENT = "LokiDoki/0.1 (offline-maps; fallback)"
_TIMEOUT_S = 3.0


async def search(
    query: str,
    viewport: tuple[float, float] | None,
    limit: int = 10,
) -> list[GeocodeResult]:
    """Call Nominatim and map rows into :class:`GeocodeResult`.

    Returns ``[]`` on any network error — callers treat that as
    "fallback produced nothing, surface offline state".
    """
    q = query.strip()
    if not q:
        return []

    params = {
        "q": q,
        "format": "json",
        "limit": str(limit),
        "addressdetails": "1",
    }

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.get(
                _NOMINATIM_URL,
                params=params,
                headers={"User-Agent": _USER_AGENT},
            )
            resp.raise_for_status()
            raw = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.info("Nominatim fallback unavailable: %s", exc)
        return []

    results: list[GeocodeResult] = []
    for i, row in enumerate(raw):
        lat = _to_float(row.get("lat"))
        lon = _to_float(row.get("lon"))
        if lat is None or lon is None:
            continue
        display = row.get("display_name") or ""
        head, _, tail = display.partition(", ")
        addr = row.get("address") or {}
        house = addr.get("house_number", "")
        street = addr.get("road", "")
        title = head or " ".join(p for p in (house, street) if p) or display
        bbox = _to_bbox(row.get("boundingbox"))
        # Score descends with list position so rank ordering is stable
        # across viewport changes — Nominatim already applied its own
        # ranking before returning.
        results.append(
            GeocodeResult(
                place_id=f"nominatim:{row.get('place_id', i)}",
                title=title,
                subtitle=tail,
                lat=lat,
                lon=lon,
                bbox=bbox,
                source="nominatim",
                score=10.0 - i * 0.1,
            )
        )
    return results


def _to_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_bbox(raw) -> tuple[float, float, float, float] | None:
    """Nominatim returns ``[minLat, maxLat, minLon, maxLon]`` as strings."""
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        min_lat, max_lat, min_lon, max_lon = (float(v) for v in raw)
    except (TypeError, ValueError):
        return None
    return (min_lon, min_lat, max_lon, max_lat)


__all__ = ["search"]
