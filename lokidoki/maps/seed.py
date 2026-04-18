"""Seed data for :mod:`lokidoki.maps.catalog`.

Three layers:

* Continents — parent-only rows (no URLs, no sizes).
* Countries — covered by a single country-scale artifact. ``us`` is the
  contiguous 48 only; Alaska and Hawaii are US-state entries so users
  can pick them independently.
* US states — all 50, generated from a compact tuple table so this
  file stays readable instead of 2 000 lines of hand-typed objects.

Sizes are rough approximations derived from land area. The catalog
is a selection UI — the real byte counts come from the server on
install and are recorded in ``MapRegionState``.
"""
from __future__ import annotations

import math

from .catalog import MapRegion, dist_base

# Geofabrik serves the .osm.pbf files directly; the PMTiles / satellite /
# Valhalla artifacts come from the configurable dist host (defaults to
# https://dist.lokidoki.app/maps; override with LOKIDOKI_MAPS_DIST_BASE).
_GEOFABRIK = "https://download.geofabrik.de"

# ── Continents (parent-only) ───────────────────────────────────────

_CONTINENTS: list[tuple[str, str, float, float, tuple[float, float, float, float]]] = [
    ("na", "North America", 45.0, -100.0, (-170.0, 10.0, -50.0, 75.0)),
    ("eu", "Europe",        54.0,   15.0, ( -25.0, 35.0,  40.0, 72.0)),
    ("as", "Asia",          35.0,  100.0, (  25.0,  0.0, 180.0, 75.0)),
]

# ── Countries ──────────────────────────────────────────────────────
#
# (region_id, label, parent, lat, lon, bbox, geofabrik_path, street_mb, pbf_mb, pi_local_ok)
#
# ``geofabrik_path`` is the ``.osm.pbf`` tail after https://download.geofabrik.de/
# — e.g. ``europe/great-britain`` resolves to great-britain-latest.osm.pbf.
_COUNTRIES: list[
    tuple[str, str, str, float, float, tuple[float, float, float, float], str, float, float, bool]
] = [
    ("us", "United States (contiguous)", "na", 39.5, -98.35,
        (-125.0, 24.5, -66.9, 49.4), "north-america/us",         2048.0, 10240.0, False),
    ("ca", "Canada",                     "na", 56.1, -106.3,
        (-141.0, 41.7,  -52.6, 83.1), "north-america/canada",    1500.0,  5500.0, False),
    ("mx", "Mexico",                     "na", 23.6,  -102.5,
        (-118.6, 14.5,  -86.7, 32.8), "north-america/mexico",     600.0,  1900.0, False),
    ("uk", "United Kingdom",             "eu", 54.0,   -2.4,
        (  -8.2, 49.9,   1.8,  60.9), "europe/great-britain",     500.0,  1200.0, False),
    ("de", "Germany",                    "eu", 51.1,   10.4,
        (   5.9, 47.3,  15.0,  55.1), "europe/germany",           700.0,  3500.0, False),
    ("fr", "France",                     "eu", 46.6,    2.2,
        (  -4.8, 41.3,   9.6,  51.1), "europe/france",            650.0,  3100.0, False),
    ("it", "Italy",                      "eu",  41.9,  12.6,
        (   6.6, 35.5,  18.5,  47.1), "europe/italy",             450.0,  1800.0, False),
    ("jp", "Japan",                      "as",  36.2, 138.3,
        ( 122.9, 24.4, 145.8,  45.6), "asia/japan",               600.0,  2200.0, False),
]

# ── US states ─────────────────────────────────────────────────────
#
# (state_code, label, geofabrik_slug, center_lat, center_lon, area_mi2)
#
# Centers are approximate state centroids; bbox is synthesised by
# radial span so the tuple stays compact. Sizes are derived below
# so the formula is visible in one place.
_US_STATES: list[tuple[str, str, str, float, float, float]] = [
    ("al", "Alabama",         "alabama",          32.80,  -86.80,  52420),
    ("ak", "Alaska",          "alaska",           64.20, -152.00, 665384),
    ("az", "Arizona",         "arizona",          34.30, -111.70, 113990),
    ("ar", "Arkansas",        "arkansas",         34.90,  -92.40,  53179),
    ("ca", "California",      "california",       37.20, -119.50, 163695),
    ("co", "Colorado",        "colorado",         39.00, -105.50, 104094),
    ("ct", "Connecticut",     "connecticut",      41.60,  -72.70,   5543),
    ("de", "Delaware",        "delaware",         39.00,  -75.50,   2489),
    ("fl", "Florida",         "florida",          28.60,  -81.80,  65758),
    ("ga", "Georgia",         "georgia",          32.90,  -83.40,  59425),
    ("hi", "Hawaii",          "hawaii",           20.20, -156.50,  10932),
    ("id", "Idaho",           "idaho",            44.20, -114.60,  83569),
    ("il", "Illinois",        "illinois",         40.00,  -89.20,  57914),
    ("in", "Indiana",         "indiana",          39.90,  -86.30,  36420),
    ("ia", "Iowa",            "iowa",             42.00,  -93.20,  56273),
    ("ks", "Kansas",          "kansas",           38.50,  -98.40,  82278),
    ("ky", "Kentucky",        "kentucky",         37.50,  -84.90,  40408),
    ("la", "Louisiana",       "louisiana",        31.10,  -91.80,  52378),
    ("me", "Maine",           "maine",            45.30,  -69.20,  35380),
    ("md", "Maryland",        "maryland",         39.00,  -76.80,  12406),
    ("ma", "Massachusetts",   "massachusetts",    42.20,  -71.80,  10554),
    ("mi", "Michigan",        "michigan",         43.90,  -84.50,  96714),
    ("mn", "Minnesota",       "minnesota",        46.30,  -94.30,  86936),
    ("ms", "Mississippi",     "mississippi",      32.70,  -89.70,  48432),
    ("mo", "Missouri",        "missouri",         38.50,  -92.30,  69707),
    ("mt", "Montana",         "montana",          47.00, -109.60, 147040),
    ("ne", "Nebraska",        "nebraska",         41.50,  -99.80,  77348),
    ("nv", "Nevada",          "nevada",           39.30, -116.70, 110572),
    ("nh", "New Hampshire",   "new-hampshire",    43.70,  -71.60,   9349),
    ("nj", "New Jersey",      "new-jersey",       40.20,  -74.70,   8723),
    ("nm", "New Mexico",      "new-mexico",       34.50, -106.10, 121590),
    ("ny", "New York",        "new-york",         42.90,  -75.50,  54555),
    ("nc", "North Carolina",  "north-carolina",   35.60,  -79.40,  53819),
    ("nd", "North Dakota",    "north-dakota",     47.50, -100.50,  70698),
    ("oh", "Ohio",            "ohio",             40.40,  -82.80,  44826),
    ("ok", "Oklahoma",        "oklahoma",         35.50,  -97.50,  69899),
    ("or", "Oregon",          "oregon",           44.10, -120.50,  98379),
    ("pa", "Pennsylvania",    "pennsylvania",     40.90,  -77.80,  46054),
    ("ri", "Rhode Island",    "rhode-island",     41.70,  -71.50,   1545),
    ("sc", "South Carolina",  "south-carolina",   33.90,  -80.90,  32020),
    ("sd", "South Dakota",    "south-dakota",     44.40, -100.20,  77116),
    ("tn", "Tennessee",       "tennessee",        35.80,  -86.30,  42144),
    ("tx", "Texas",           "texas",            31.10,  -99.30, 268596),
    ("ut", "Utah",            "utah",             39.30, -111.70,  84897),
    ("vt", "Vermont",         "vermont",          44.00,  -72.70,   9616),
    ("va", "Virginia",        "virginia",         37.80,  -78.20,  42775),
    ("wa", "Washington",      "washington",       47.40, -120.40,  71362),
    ("wv", "West Virginia",   "west-virginia",    38.50,  -80.70,  24230),
    ("wi", "Wisconsin",       "wisconsin",        44.30,  -89.60,  65498),
    ("wy", "Wyoming",         "wyoming",          42.80, -107.30,  97813),
]


def _state_pmtiles_mb(area_mi2: float) -> float:
    """Rough PMTiles size from a state's area.

    Matches the PLAN.md size table data points (CT ~80 MB, CA ~400 MB)
    with a sqrt falloff so the bigger the state, the less bytes per
    square mile (roads + labels are denser in small dense states).
    """
    return round(max(20.0, math.sqrt(area_mi2) * 1.2), 1)


def _span_for_area(area_mi2: float, center_lat: float) -> tuple[float, float]:
    """Synthesise a (lat_span, lon_span) pair from a state's area.

    Good enough for a draw-a-rectangle map marker — the authoritative
    bbox comes from the actual PMTiles header once a region is
    installed.
    """
    side_mi = max(math.sqrt(area_mi2), 30.0)  # floor for tiny states
    lat_span = side_mi / 69.0
    cos_lat = max(math.cos(math.radians(center_lat)), 0.25)
    lon_span = lat_span / cos_lat
    return (round(lat_span, 2), round(lon_span, 2))


def build_catalog() -> list[MapRegion]:
    """Return the full ``MapRegion`` list in seed order."""
    out: list[MapRegion] = []
    dist = dist_base()

    # Continents — parent-only, no downloads.
    for region_id, label, lat, lon, bbox in _CONTINENTS:
        out.append(MapRegion(
            region_id=region_id, label=label, parent_id=None,
            center_lat=lat, center_lon=lon, bbox=bbox,
            street_size_mb=0.0, satellite_size_mb=0.0,
            street_url_template="", satellite_url_template="",
            street_sha256="", satellite_sha256=None,
            valhalla_size_mb=0.0, valhalla_url_template="", valhalla_sha256="",
            pbf_size_mb=0.0, pbf_url_template="", pbf_sha256="",
            pi_local_build_ok=False,
        ))

    # Countries.
    for (region_id, label, parent, lat, lon, bbox, geofabrik_path,
         street_mb, pbf_mb, pi_ok) in _COUNTRIES:
        out.append(MapRegion(
            region_id=region_id, label=label, parent_id=parent,
            center_lat=lat, center_lon=lon, bbox=bbox,
            street_size_mb=street_mb,
            satellite_size_mb=round(street_mb * 20.0, 1),
            street_url_template=f"{dist}/{region_id}/streets.pmtiles",
            satellite_url_template=f"{dist}/{region_id}/satellite.tar.zst",
            street_sha256="", satellite_sha256=None,
            valhalla_size_mb=round(street_mb * 0.5, 1),
            valhalla_url_template=f"{dist}/{region_id}/valhalla.tar.zst",
            valhalla_sha256="",
            pbf_size_mb=pbf_mb,
            pbf_url_template=f"{_GEOFABRIK}/{geofabrik_path}-latest.osm.pbf",
            pbf_sha256="",
            pi_local_build_ok=pi_ok,
        ))

    # US states.
    for code, label, slug, lat, lon, area_mi2 in _US_STATES:
        region_id = f"us-{code}"
        street_mb = _state_pmtiles_mb(area_mi2)
        pbf_mb = round(max(10.0, street_mb * 2.5), 1)
        lat_span, lon_span = _span_for_area(area_mi2, lat)
        bbox = (
            round(lon - lon_span, 3), round(lat - lat_span, 3),
            round(lon + lon_span, 3), round(lat + lat_span, 3),
        )
        out.append(MapRegion(
            region_id=region_id, label=label, parent_id="us",
            center_lat=lat, center_lon=lon, bbox=bbox,
            street_size_mb=street_mb,
            satellite_size_mb=round(street_mb * 20.0, 1),
            street_url_template=f"{dist}/{region_id}/streets.pmtiles",
            satellite_url_template=f"{dist}/{region_id}/satellite.tar.zst",
            street_sha256="", satellite_sha256=None,
            valhalla_size_mb=round(street_mb * 0.5, 1),
            valhalla_url_template=f"{dist}/{region_id}/valhalla.tar.zst",
            valhalla_sha256="",
            pbf_size_mb=pbf_mb,
            pbf_url_template=f"{_GEOFABRIK}/north-america/us/{slug}-latest.osm.pbf",
            pbf_sha256="",
            pi_local_build_ok=pbf_mb < 500.0,
        ))

    return out
