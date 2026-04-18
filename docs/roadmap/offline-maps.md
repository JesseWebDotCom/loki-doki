# Offline Maps — chunked plan

Today the Maps page needs an internet connection for both the map
imagery (OpenStreetMap public raster tiles) and address search
(Nominatim public API). The goal is to let a user download a region
they care about — their state, country, or a custom bounding box —
and have the map + address search + road directions work without any
network.

This is deliberately scoped in independently-shippable chunks so we
don't hide a multi-week feature behind one "offline maps" PR.

---

## Chunk 1 — PMTiles infrastructure (no user-visible feature yet)

**Goal**: MapLibre can render from a local `.pmtiles` file when one is
present. Still online-first — this just wires up the plumbing.

**Work**:
- Add the `pmtiles` npm package.
- Register the `pmtiles://` protocol with MapLibre at app startup.
- Create a new map style JSON based on the Protomaps basemap schema
  (vector tiles instead of raster). Start with one theme (dark) that
  matches the Onyx Material palette.
- `MapsPage` checks for `/api/v1/maps/tiles/<region_id>` before falling
  back to the online OSM style — but since no region is installed yet,
  the user sees exactly the same behavior as today.

**Ship criteria**: no visible change for users; PMTiles protocol works
against a dev-local test file.

**Estimated size**: 1 day.

---

## Chunk 2 — Downloadable map-region catalog

**Goal**: A user can pick a region from the admin panel and download
its map tile bundle, same flow as downloading Wikipedia today.

**Work**:
- Extend the archive catalog with a `MapRegion` type (distinct from
  `ZimSource`) covering: label, bounding box, approximate size,
  download URL on a Protomaps mirror.
- Seed the catalog with a small starter list:
  - United States — regional (~2 GB)
  - United Kingdom — regional (~500 MB)
  - Japan — regional (~1 GB)
  - California (state example, ~400 MB)
  - Connecticut (small-state example, ~80 MB)
- Admin panel category "Maps" with hero cards and the same toggle UX
  as ZIM archives. Each card shows bounding-box preview + size.
- `resolver.py` gets a new path for PMTiles downloads (single file,
  not HTML-listing resolution).

**Ship criteria**: admin can toggle a region on, watch the download
progress, see it appear in the "Installed" list. Map tiles for that
region are served via a new backend route.

**Estimated size**: 2-3 days.

---

## Chunk 3 — Frontend wiring for installed regions

**Goal**: When the user opens `/maps` and has a region installed,
MapLibre uses the local PMTiles instead of the OSM public server.
Fall back to online when the view is outside every installed region.

**Work**:
- Frontend polls `/api/v1/maps/regions` on mount; merges the
  bounding-boxes into a region-aware map source.
- `MapsPage` style branching: if 1+ region installed → vector PMTiles
  style (offline); if 0 installed → raster OSM style (online, today's
  behavior).
- When the user pans outside an installed region while offline, show a
  soft tint on the out-of-region area and a pill ("No tiles for this
  area — install a larger region").

**Ship criteria**: toggling a region on in the admin panel immediately
lights up that region's tiles in the Maps page; offline, the region
stays visible and outside-region is politely dimmed.

**Estimated size**: 1-2 days.

---

## Chunk 4 — Offline address search

**Goal**: Address/city/ZIP search works without Nominatim.

**Options** (pick one, not all):
- **4a — Bundled address index per region (preferred)**. Extract a
  searchable index from the downloaded OSM PBF. Ship a small Rust/Go
  geocoder like [Pelias](https://github.com/pelias/pelias) or
  [Photon](https://github.com/komoot/photon) as a sidecar process
  driven by the Python API. Per-region index sizes: US 5-8 GB, CA 400
  MB, state-level 50-300 MB.
- **4b — Simpler FTS-only index**. Extract `addr:*` + `place=*` nodes
  from the PBF into SQLite FTS5 at download time. Loses typo tolerance
  and "near me" biasing, but stays in-process and adds ~200 MB per
  region. Good enough for ZIP/city lookup; weak for full addresses.

Recommendation: **start with 4b** for the first ship (one process, no
Java/Rust sidecar), upgrade to 4a if users hit typo or fuzzy-match
gaps.

**Ship criteria**: with internet off, typing a query still returns
address results when at least one region is installed.

**Estimated size**: 4b ~3 days, 4a ~1 week.

---

## Chunk 5 — Routing / directions (stretch)

**Goal**: "How long to drive to San Francisco" works offline.

**Work**: Bundle [OSRM](http://project-osrm.org/) or
[Valhalla](https://github.com/valhalla/valhalla) as a sidecar against
the same PBF extract. Most users don't need this day-one.

**Ship criteria**: `get_eta` + `get_directions` skills route offline
against the installed region.

**Estimated size**: 1 week.

---

## Size overview (install footprint by region)

| Region                    | Tiles    | FTS-only addresses | Pelias/Photon |
|---------------------------|----------|--------------------|---------------|
| Small state (CT)          | ~80 MB   | ~40 MB             | ~120 MB       |
| Large state (CA)          | ~400 MB  | ~200 MB            | ~600 MB       |
| United Kingdom            | ~500 MB  | ~300 MB            | ~800 MB       |
| United States (contig.)   | ~2 GB    | ~1.5 GB            | ~6 GB         |
| Whole world               | ~100 GB  | ~60 GB             | ~200 GB       |

The catalog should default to "small region" presets to stay under 1 GB
for first-time users.

---

## Non-goals for v1

- Satellite/aerial imagery — too big (tens of GB per region) and
  separate tileset pipeline. Streets-only is enough.
- Turn-by-turn navigation — Chunk 5 only provides ETA/route geometry.
  Voice-guided navigation is a Phase-later feature.
- Live traffic — explicitly a networked feature; always requires
  internet and is out of scope for "offline maps".
- Custom bounding-box uploads — catalog-only for v1. Advanced users can
  still side-load a PMTiles file to the install dir.
