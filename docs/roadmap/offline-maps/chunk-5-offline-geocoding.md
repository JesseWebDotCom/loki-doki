# Chunk 5 — Offline geocoding (FTS5 address index per region)

## Goal

Swap the Search panel from online Nominatim to a local SQLite FTS5 index built per region from that region's `.osm.pbf` extract (downloaded in Chunk 2). After this chunk, with the network off, typing a query in the Search panel returns address / city / ZIP results from every installed region — merged, ranked by proximity to the viewport center — and the existing Nominatim path is a fallback only when zero regions cover the query area.

Photon / Pelias full geocoders are explicitly **deferred**. FTS5 covers city / ZIP / full-address prefix lookups for ~40–300 MB per state; this is enough for the 90% path. If fuzzy-match gaps show up in real use, the `lokidoki/maps/geocode/` module has a swappable backend interface — Photon can ride the same API later.

## Files

- `lokidoki/maps/geocode/__init__.py` — new: `GeocoderProtocol`, `GeocodeResult` dataclass, `merge_results()` utility.
- `lokidoki/maps/geocode/fts_index.py` — new: `build_index(pbf_path, output_db, region_id)` — parses the PBF with `osmium` (dep) or `pyrosm`, extracts `addr:*` + `place=*` + `amenity=*` nodes/ways, populates FTS5 table `places(region, osm_id UNINDEXED, name, housenumber, street, city, postcode, admin1, lat UNINDEXED, lon UNINDEXED, class UNINDEXED)`.
- `lokidoki/maps/geocode/fts_search.py` — new: `search(query, viewport, regions) -> list[GeocodeResult]`. Uses FTS5's `MATCH` with prefix tokens + a proximity bonus (Haversine-distance penalty applied post-rank). Limit 10, merge across regions, dedup near-duplicates (<50 m + same street + same number).
- `lokidoki/maps/geocode/nominatim_fallback.py` — new: thin wrapper around the existing MapsPage Nominatim call, only invoked when no installed region covers the viewport.
- `lokidoki/maps/store.py` — extend: after a region's `streets.pmtiles` + `.pbf` download, kick off `build_index()` as a background task; report progress via the same SSE stream as Chunk 2; when complete, mark `geocoder_installed: true` in `MapRegionState`; on success the `.pbf` can be deleted to save disk (a flag in config controls this, default `true` for users, `false` for devs — expose in Settings → Maps).
- `lokidoki/api/routes/maps.py` — extend: `GET /geocode?q=...&lat=...&lon=...` routes to FTS first, Nominatim fallback.
- `frontend/src/pages/maps/panels/SearchPanel.tsx` — swap the `searchPlaces()` helper to call `/api/v1/maps/geocode` instead of Nominatim directly. No UI change visible to the user — the result shape is identical.
- `pyproject.toml` — add `pyosmium` (or `pyrosm`, whichever is purer — prefer `pyosmium` for raw pbf streaming speed).
- `tests/unit/test_geocode_fts_build.py` — new.
- `tests/unit/test_geocode_fts_search.py` — new.
- `tests/unit/test_geocode_api.py` — new.

Read-only: `lokidoki/archives/extract.py` if it has a pbf-read pattern (probably not; archives are ZIM).

## Actions

1. **Schema** (`fts_index.py`):
   ```sql
   CREATE VIRTUAL TABLE places USING fts5(
       region UNINDEXED,
       osm_id UNINDEXED,
       name,
       housenumber,
       street,
       city,
       postcode,
       admin1,
       lat UNINDEXED,
       lon UNINDEXED,
       class UNINDEXED,
       tokenize = "unicode61 remove_diacritics 2"
   );
   ```
   One `places.sqlite` per region at `data/maps/<region>/geocoder.sqlite` — separate so uninstalling a region is `rm -rf`.
2. **Extraction rules**:
   - Emit a row per OSM node with `addr:housenumber` + `addr:street` (full addresses).
   - Emit a row per OSM node/relation with `place=city|town|village|hamlet` (settlements).
   - Emit a row per `boundary=postal_code` or way with `addr:postcode` aggregated by ZIP prefix.
   - Skip anything without a name or housenumber + street pair. Target ~200 addresses / MB.
3. **Ranking** (`fts_search.py`):
   - BM25 (FTS5 default) + a Haversine penalty `score += -0.02 * distance_km` (tuned; viewport bias). Cap distance penalty at −3.0.
   - Prefix matching: wrap user tokens with `*` on trailing tokens (`"150 stil*"`) for live-typing autocomplete.
   - Filter by installed-region list — callers pass it, so uninstalled regions never return rows.
4. **API shape** (`GET /geocode`):
   ```json
   {
     "results": [
       {
         "place_id": "us-ct:osm:12345",
         "title": "150 Stiles St",
         "subtitle": "Milford, CT, United States",
         "lat": 41.242964,
         "lon": -73.069,
         "bbox": [minLon, minLat, maxLon, maxLat] | null,
         "source": "fts"
       },
       ...
     ],
     "fallback_used": false
   }
   ```
   When every installed region's bbox excludes the viewport, fall back to Nominatim and set `fallback_used: true`. If the user is offline and nothing covers the viewport, return `{results: [], fallback_used: false, offline: true}` — the frontend already shows the out-of-coverage banner.
5. **SearchPanel wiring**: keep the existing debounce + result-list UI. Only change the fetch URL + response mapping. When `fallback_used: true`, show a tiny muted chip next to the input: *"Using online search for this area — install a region for offline results."* When `offline: true`, an empty-state row reading *"No offline results for this area. Install a region to search here offline."*
6. **Background indexing UX**: under Settings → Maps, each region row gains a small progress subline: `Geocoder: ready · 42 MB` / `Geocoder: indexing 14%`. Reuse Chunk 2's SSE stream with a new event type `{artifact: "geocoder", phase: "indexing" | "ready", bytes_done, bytes_total}`.
7. **Tests**:
   - `test_geocode_fts_build.py`: run `build_index()` against a 2 MB fixture PBF in `tests/fixtures/ct_sample.osm.pbf`; assert row counts for addresses / cities / postcodes; assert a known address (`"150 Stiles St"` if in the fixture, otherwise a synthetic one) retrievable via MATCH.
   - `test_geocode_fts_search.py`: proximity bonus ranks a CT hit over a matching NY hit when viewport is Hartford; prefix tokenization works on half-typed queries.
   - `test_geocode_api.py`: `fallback_used` flips correctly; `offline` true on empty local + simulated network-down; schema conformance.

## Verify

```bash
uv run pytest tests/unit/test_geocode_fts_build.py tests/unit/test_geocode_fts_search.py tests/unit/test_geocode_api.py -x && \
cd frontend && pnpm tsc --noEmit && pnpm build && cd .. && \
uv run python -c "
import asyncio, sqlite3
from pathlib import Path
from lokidoki.maps.geocode.fts_search import search
# Expect: if data/maps/us-ct/geocoder.sqlite exists, return >=1 hit for 'stiles st'
db = Path('data/maps/us-ct/geocoder.sqlite')
if db.exists():
    hits = asyncio.run(search('stiles st', (41.24, -73.07), ['us-ct']))
    assert hits, 'expected at least one hit for stiles st'
    print('FTS OK —', hits[0].title)
else:
    print('no CT index installed; backend-only tests sufficient')
"
```

Manual smoke: wifi off, install CT in admin panel (or pre-populate for the test), open `/maps`, type `150 stiles` — should see Connecticut results with a muted `source: fts` indicator. Type `montmartre paris` — with France not installed, the online-fallback chip appears (or offline empty-state if offline).

## Commit message

```
feat(maps): offline FTS5 geocoder per region + Nominatim fallback

Each installed region now builds a data/maps/<region>/geocoder.sqlite
FTS5 index from its Geofabrik .osm.pbf during Chunk-2 download. The
new /api/v1/maps/geocode route unions results across installed
regions, ranks with BM25 plus a viewport-proximity bonus, and falls
back to Nominatim only when no region covers the viewport.

SearchPanel now hits /geocode; a muted chip surfaces which backend
served the query so users know when they're online-only. The .pbf is
deleted after indexing by default to reclaim disk (configurable).

Adds pyosmium as a dep. Photon/Pelias explicitly deferred per PLAN.md.

Refs docs/roadmap/offline-maps/PLAN.md chunk 5.
```

## Deferrals section (append as you discover)

*(empty)*
