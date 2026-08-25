---
title: Maps
description: Offline maps with MapLibre, pmtiles, GraphHopper routing, and an FTS geocoder.
sidebar:
  order: 11
---

## Overview

Fully offline maps: vector tiles rendered client-side with MapLibre GL, routing via a bundled GraphHopper, and place search via a per-region SQLite FTS5 geocoder. Nothing needs a tile API key or internet at runtime once a region is built. Ported from the v2 Python toolchain to TypeScript/Bun.

Relevant code:

- `frontend/src/pages/MapsPage.tsx` and `frontend/src/pages/maps/*`: MapLibre render, panels, routing UI
- `backend/src/routes/maps.ts`: tiles/glyphs serving, geocode, routing, pins
- `backend/src/routes/adminMaps.ts`: toolchain install + region build/reindex/delete (admin)
- `backend/src/lib/maps/{toolchain,build,geocoder,graphhopper,store,catalog,paths,terrain,landcover}.ts`
- `map_regions` and `maps_saved_pins` tables in `backend/src/db/schema.ts`

---

## Stack

| Component | Version | Role |
|---|---|---|
| MapLibre GL JS | n/a | Client-side vector tile rendering |
| PMTiles | n/a | Single-file vector tile archive (`pmtiles.js` reads byte ranges) |
| Planetiler | `0.8.4` | OSM PBF → `streets.pmtiles` vector tiles (Java) |
| GraphHopper | `10.1` | OSM PBF → routing graph + runtime routing (Java) |
| go-pmtiles | `1.30.3` | Packs DEM tiles → `dem.pmtiles` for terrain/hillshade |
| Temurin JRE | `21.0.5+11` | Runs Planetiler + GraphHopper |
| FTS5 geocoder | n/a | Per-region SQLite full-text place index (built in-process) |

> The geocoder is built **in-process** by streaming the region PBF with the pure-JS `osm-pbf-parser` dependency. There is **no `osmium` (or pyosmium) binary** involved; the toolchain is self-contained and installs with the feature. (A stale comment in `build.ts` still references osmium, but the implemented `buildGeocoder()` uses `osm-pbf-parser`.)

The toolchain is downloaded at runtime via Admin → Features → Maps (`installMapsToolchain`), never bundled, into `data/maps/tools/`. `isMapsToolchainInstalled()` = JRE + Planetiler jar + GraphHopper jar all present.

---

## Tile / region pipeline

`buildRegion(regionId)` in `backend/src/lib/maps/build.ts` runs these phases (each `upsert`s a flag on `map_regions` and emits SSE `progress` events):

1. **`downloading`**: fetch the region OSM PBF (Geofabrik URL from the catalog) to `regionPbfPath`.
2. **`building_streets`**: Planetiler → `streets.pmtiles` (`--download` fetches ~1.4 GB shared Natural Earth + water-polygon base data on first build).
3. **`building_terrain`**: best-effort DEM hillshade → `dem.pmtiles` (uses `go-pmtiles`; self-heals the binary via `installPmtilesBin` if missing).
4. **`building_landcover`**: best-effort ESA WorldCover wash → `landcover.pmtiles`.
5. **`building_routing`**: GraphHopper `import` with a generated `import-config.yml` → routing graph dir.
6. **`building_geocoder`**: in-process PBF stream → FTS5 `geocoder.sqlite` (best-effort).

The raw PBF is deleted afterward unless `MAIPAI_KEEP_PBF=1`. Terrain, landcover, and geocoder are best-effort: a failure logs and skips, leaving an otherwise-usable region. Build heaps are tunable via `MAIPAI_PLANETILER_HEAP_MB` / `MAIPAI_GRAPHHOPPER_HEAP_MB` (default 4096).

**World overview:** a one-time low-detail (`maxzoom 7`) global basemap is built from a tiny Monaco seed PBF + Natural Earth, plus `world-countries/states/labels.geojson` parsed from the Natural Earth SQLite (minimal in-file WKB parser). It's served at `/api/maps/tiles/_overview/streets.pmtiles` and rendered when zoomed out or outside any installed region. `maybeBuildWorldOverview()` runs at boot if the toolchain is present but the overview is missing.

---

## Serving tiles (`backend/src/routes/maps.ts`)

Tiles, the overview, and glyphs are served **before** the `requireAuth` middleware (static, non-sensitive) because MapLibre/`pmtiles.js` can't follow an auth redirect and would 401-flood on session expiry:

- `GET /api/maps/tiles/_overview/streets.pmtiles`
- `GET /api/maps/tiles/:regionId/{streets,dem,landcover}.pmtiles`
- `GET /api/maps/tiles/_overview/world-{countries,states,labels}.geojson`
- `GET /api/maps/glyphs/:fontstack/:range`: font glyph PBFs, with `FONT_ALIASES` mapping Planetiler's baked "Open Sans"/"Arial Unicode" names onto the bundled Noto Sans.

`serveFile()` implements precise HTTP **Range** support with `fs.readSync` (returning exactly the requested bytes) because `pmtiles.js` issues many small range requests; `Bun.file().slice()` did not honor the slice and streamed the whole file, rendering the map blank.

Everything below `maps.use('*', requireAuth)` (geocode, route, pins, favicon proxy) is authenticated.

---

## Geocoder

`backend/src/lib/maps/geocoder.ts` does FTS5 search + reverse lookup over each installed region's `geocoder.sqlite` (`places` FTS5 table + an r-tree spatial index), linearly across the small set of installed regions in-process.

- `GET /api/maps/geocode?q=&category=&lat=&lon=&limit=` → forward search (`search()`), tokenized with US-state-abbrev and stop-word filtering, bucketed/weighted ranking.
- `GET /api/maps/geocode/reverse?lat=&lon=&radius_km=` → nearest place (`reverse()`).

The FTS5 schema (`buildGeocoder` in `build.ts`) indexes named nodes at their own coordinates and named ways at a representative node, capturing `name`, address parts, `admin1`, `phone`, `website`, `class` (POI/settlement/address), and `opening_hours`. `reindexRegion()` rebuilds just the geocoder (needs the kept PBF; tracked by `geocoder_schema_version`).

---

## Routing

GraphHopper runs in-process from the bundled jar (`backend/src/lib/maps/graphhopper.ts`):

- `POST /api/maps/route`: body `{ origin, destination, waypoints, profile, alternates, avoid }`. Profiles: `auto`, `pedestrian`, `bicycle`, `hiking`, `mtb`. Returns geometry, distance, duration, and turn-by-turn steps; `RouteUnavailableError` → `503` with `Retry-After` (graph still warming).
- `GET /api/maps/eta?from_lat=&from_lon=&to_lat=&to_lon=&profile=`: quick ETA.

---

## Saved pins

`maps_saved_pins` is per-user. CRUD at `GET/POST /api/maps/pins`, `PATCH/DELETE /api/maps/pins/:pinId`. A pin carries `label`, `lat`/`lon`, a constrained `color`, optional `notes`, and a `place_ref` JSON snapshot. Pin collections are stubbed (`GET /api/maps/collections` returns empty) so the UI degrades cleanly. Brand logos / POI photos / incidents are also stubbed (`404`/empty) pending a v2 port; the frontend falls back to lucide icons.

---

## Frontend (`MapsPage.tsx`)

A single MapLibre map is created **once**; theme / layer-mode / region changes go through `map.setStyle()` rather than recreating the map (recreation tears down in-flight tile requests and burns WebGL contexts). Tile source is chosen per viewport via `chooseTileSource()` (installed region vs. world overview), driving an out-of-coverage banner. Layer modes are `map` / `3d` (pitched, terrain) / `satellite` (online only; auto-exits to `map` when `appMode === 'local'` or there's no network). The page publishes UI context (`usePublishUIContext`) describing the selected place so the companion is aware of map state. Deep links (`?from=&to=&q=…`) are parsed on mount to pre-fill directions/search.

---

## Admin (Admin → Features → Maps)

`backend/src/routes/adminMaps.ts` (all `requireAdmin`):

- `GET /api/admin/maps/catalog`: region tree with per-region install state/phase/building flag.
- `GET /api/admin/maps/storage`: bytes-on-disk aggregate per artifact + per region.
- `POST /api/admin/maps/install-toolchain`: SSE install of JRE + Planetiler + GraphHopper + glyphs + overview.
- `GET /api/admin/maps/download/:regionId`: SSE region build (serialized `progress` writes; `done` / `cancelled` / `error`). One active build per region; client disconnect aborts it.
- `POST /api/admin/maps/cancel/:regionId`, `POST /api/admin/maps/reindex/:regionId`, `DELETE /api/admin/maps/:regionId`.

Builds and toolchain installs are blocked in offline mode (`isDownloadBlocked()` → `503`). The frontend admin UI lives in `frontend/src/components/admin/MapsRegionSection.tsx`.

---

## `map_regions` table

One row per region, mostly artifact-presence flags so the API can report partial installs:

| Column | Notes |
|---|---|
| `region_id` | unique, e.g. `us-ct` |
| `install_status` | `pending` \| `building` \| `ready` \| `error` \| `cancelled` |
| `phase` | current build phase string |
| `street_installed` | `streets.pmtiles` present (gates whether a region renders) |
| `dem_installed`, `landcover_installed` | terrain / landcover artifacts |
| `valhalla_installed` | **routing-graph present** (legacy column name; routing is GraphHopper, not Valhalla) |
| `pbf_installed` | raw PBF kept on disk (`MAIPAI_KEEP_PBF=1`) |
| `geocoder_installed`, `openaddresses_installed` | geocoder index present |
| `geocoder_schema_version` | for `reindex` migrations |
| `bytes_on_disk` | JSON map of artifact → bytes |
| `last_error`, `installed_at`, `created_at`, `updated_at` | status/timestamps |
