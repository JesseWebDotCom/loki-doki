# Geocode Coverage — every address findable, every named place findable, neighbor labels visible

## Goal

After every chunk lands, the LokiDoki Maps search returns a usable hit
for **any** real US mailing address (not only OSM-tagged ones), for
named buildings / POIs (e.g. *"Bridgewater Associates"*), and the map
keeps showing neighboring state / country labels at every zoom level —
not just the world view.

Concretely, the bar is:

- *"500 Nyala Farms Road, Westport CT"* → returns a marker at the
  parcel for #500 (sourced from OpenAddresses parcel data, not OSM).
- *"Bridgewater Associates"* → returns the building polygon centroid
  in Westport (sourced from OSM `office` / `building+name`).
- Zooming into Connecticut still shows `MASSACHUSETTS`, `NEW YORK`,
  `RHODE ISLAND` labels on the surrounding states.

The "proper" path — not a search-side workaround — is to ingest
[OpenAddresses](https://openaddresses.io) parcel data into the same
FTS5 index that already holds OSM addresses. This is the same approach
[Pelias](https://github.com/pelias/pelias) (the open geocoder powering
Geocode Earth, formerly Mapzen) takes: OSM gives you POIs and street
geometry, OpenAddresses gives you the comprehensive housenumber
coverage that OSM lacks. Nominatim alone tops out at the OSM-tagged
subset (~30–50 % of US addresses); OpenAddresses pushes that to ~95 %
because it is sourced from county / state GIS parcel exports.

## How to use this document (operating contract)

This is a **chunked plan**. Each chunk is one fresh Claude Code
session. The execution rules are non-negotiable:

1. Open this `PLAN.md`. Pick the first row in the status table whose
   `Status` is `pending`. Open ONLY that chunk doc. Before doing
   substantive work, send a short announcement naming the chunk you
   are starting (for example: *"Starting chunk 4 — Search tokenizer
   hardening."*).
2. Read the global context section once. Read the chunk doc top to
   bottom. Do **not** open other chunk docs in this session.
3. Execute every step in the chunk's `## Actions` block. Only touch
   files listed in `## Files`. Sprawl gets deferred to a later chunk
   via `## Deferrals` — never expanded into the current chunk.
4. Run the chunk's `## Verify` command. If it fails, diagnose or write
   `## Blocker` and stop. Never edit the verify command to make it
   pass.
5. On pass, stage **only** the chunk's files and commit using the
   chunk's `## Commit message`. Flip the row in this `PLAN.md` to
   `done` and paste the SHA in the `Commit` column. Immediately after
   the commit, send a short completion note naming the chunk you
   processed and the commit SHA (for example: *"Processed chunk 4 —
   committed as abc1234."*). Do NOT push, open a PR, or merge unless
   the user types "push".
6. **STOP. Do not begin the next chunk in the same session.**

## Status

| # | Chunk | Status | Commit |
|---|-------|--------|--------|
| 1 | [OpenAddresses preflight + pin](chunk-1-openaddresses-preflight.md) | done | 50267c7 |
| 2 | [Ingest OpenAddresses CSV into FTS](chunk-2-openaddresses-ingest.md) | done | 0c5f1d3 |
| 3 | [Index named OSM POIs / buildings](chunk-3-osm-named-pois.md) | done | cb64e53 |
| 4 | [Search tokenizer hardening](chunk-4-search-tokens.md) | done | d7733f5 |
| 5 | [World labels visible at all zooms](chunk-5-world-labels-zoom.md) | done | 7c2e222 |
| 6 | [Install resilience: atomic indexer + skip-if-hash + UI clear](chunk-6-install-resilience.md) | done | f525cfd |
| 7 | [Polygon-based world labels](chunk-7-polygon-world-labels.md) | pending | |
| 8 | [Directions UX: step-click map blank + delete recent](chunk-8-directions-ux.md) | pending | |
| 9 | [Style polish: route shields, stream labels, road hierarchy](chunk-9-style-polish.md) | pending | |
| 10 | [POI icon sprite + click-to-popup PlaceDetailsCard](chunk-10-poi-icons-popup.md) | pending | |
| 11 | [Dark theme tuning + light theme + system-theme toggle](chunk-11-theme-tuning.md) | pending | |

## Global context

### Where the geocoder lives today

- Per-region FTS5 index at
  `data/maps/<region_id>/geocoder.sqlite`. Schema is the
  `places` virtual table defined in
  [lokidoki/maps/geocode/fts_index.py](../../../lokidoki/maps/geocode/fts_index.py)
  — columns: `region, osm_id, name, housenumber, street, city,
  postcode, admin1, lat, lon, class`.
- The index is built from a Geofabrik `.osm.pbf` extract by
  [build_index()](../../../lokidoki/maps/geocode/fts_index.py).
  Runner lives in
  [lokidoki/maps/store.py](../../../lokidoki/maps/store.py)
  (`_build_geocoder_step`).
- Search runs against the index via
  [fts_search.py](../../../lokidoki/maps/geocode/fts_search.py)
  using strict-AND BM25 + viewport-Haversine penalty.
- After the per-region build pipeline finishes, the source PBF is
  deleted unless `LOKIDOKI_KEEP_PBF=1` (see `_keep_pbf()` in
  `store.py`). Chunks 2 and 3 rebuild from the PBF, so we either keep
  it or re-download it.

### Where the world labels live today

- World-overview pmtiles (Natural Earth, z0–z7) sits at
  `.lokidoki/tools/planetiler/world-overview.pmtiles`. Style wiring
  is in
  [frontend/src/pages/maps/style-dark.ts](../../../frontend/src/pages/maps/style-dark.ts)
  — see the `world_place_country` and `world_place_state` symbol
  layers.
- Both layers carry `maxzoom: 7`, which is why neighboring state /
  country names disappear when the user zooms into a region's streets
  pmtiles. Chunk 5 fixes this.

### Hard rules that apply to every chunk in this plan

- **Bootstrap is the only network boundary.** Every byte that runs
  through this plan is either downloaded by a bootstrap preflight
  step or staged in the offline bundle. Runtime code never reaches
  the public internet for OpenAddresses, Geofabrik, or any other
  upstream.
- **No vendored binaries.** The OpenAddresses CSVs land in the
  user's data directory at install time — they are not committed to
  the repo, and they go through `versions.py` pinning + the offline
  bundle just like every other upstream artifact.
- **No `pip install` / `npm install` from the agent shell.** Any new
  Python dep goes in `pyproject.toml` and the bootstrap installs it.
- **Files under 300 lines, functions under 40 lines.** Split before
  appending.
- **Tests first.** Each chunk lands with unit tests covering the new
  paths. The verify command runs them.

### Why OpenAddresses (and not just OSM)

OSM stores addresses as either (a) nodes / ways with explicit
`addr:housenumber` + `addr:street` tags, or (b) `addr:interpolation`
ways linking two addressed endpoints with a linear interpolation
hint. In the US:

- Only a fraction of buildings carry explicit housenumber tags.
- TIGER-imported `addr:interpolation` data is patchy and was not
  re-imported uniformly across the country.

OpenAddresses publishes per-region CSVs sourced from county and state
GIS parcel exports. Each row is `LON,LAT,NUMBER,STREET,UNIT,CITY,
DISTRICT,REGION,POSTCODE,ID,HASH`. For Connecticut alone that is
~1.5 M parcel-level rows. After ingestion, every legitimate
mailing address is in the FTS index — *"500 Nyala Farms Road"* is
no longer a special case.

The downside is size (~30–80 MB gzipped per US state) and
licensing (per-source attribution). The plan handles both: bootstrap
downloads + verifies SHA, and the runtime UI carries an attribution
chip alongside the existing OpenStreetMap one.

### How POI search fits

OSM **does** have rich POI data — the geocoder just isn't reading
it. *"Bridgewater Associates"* is in the Westport PBF as a way
tagged `office=*` + `name=Bridgewater Associates`, but the current
indexer only emits rows for tagged addresses + settlements +
postcodes. Chunk 3 extends the indexer to also emit a row per named
feature for the POI keys (`office`, `amenity`, `building+name`,
`shop`, `tourism`, `leisure`, `healthcare`, `craft`).

## NOTE — append-only cross-chunk discoveries

- 2026-04-19 — Observed in dev: re-installing `us-fl` overwrote the
  existing `geocoder.sqlite` in place (down from 367 MB / millions
  of rows to 24 MB / 154k rows) when the indexer was killed mid-build,
  AND the frontend kept showing *"Indexing addresses 29k rows"* even
  after the install task disappeared (server returns
  `{status: "idle"}` for the SSE init event). Drove the chunk 6
  authoring (atomic indexer + skip-if-hash + UI clear).
- 2026-04-19 — Observed in dev: panning into Russia / Canada / large
  empty regions hides the country label entirely; labels at the
  viewport edge truncate to fragments like `GHANISTAN`, `ENISTAN`,
  `ISTAN`. Root cause is `Point` features anchored at NE's
  `label_x`/`label_y` — fixed in chunk 7 by switching to polygon
  geometry with symbol-placement-on-polygon.
- 2026-04-19 — UX papercut + Apple-Maps-parity items added as chunks
  8–11: clicking a turn-by-turn step blanks the canvas (chunk 8);
  no per-row recent delete (chunk 8); no route shields / stream
  labels / road hierarchy (chunk 9); POIs render as bare text and
  building click does nothing (chunk 10); dark theme is monochrome
  and there's no light-mode toggle (chunk 11). All four were
  triaged from a side-by-side LokiDoki vs Google Maps screenshot
  comparison of 150 Stiles St, Milford CT.
