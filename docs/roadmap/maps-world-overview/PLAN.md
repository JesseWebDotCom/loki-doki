# World Overview Basemap — Execution Plan

Goal: ship a global low-zoom basemap that is always available on the
Maps page, regardless of which regions the user has installed. Today
the MapLibre style is backed by exactly one source — the currently
selected region's `streets.pmtiles`. That file holds tiles only for
(x, y) cells that intersect the region's bbox. Consequence:

1. **Labels missing outside installed regions.** Country names, state
   names, ocean names — none render once the viewport leaves the
   installed bbox. Screens show dark/blue silhouettes with no text.
2. **Blank viewport on zoom-out.** At mid zooms (roughly z3–z6) the
   region's pmtiles has tiles only for the handful of (x, y) cells
   containing the region. Pan/zoom to any other quadrant and every
   tile request returns nothing → MapLibre paints only the background
   color → the whole viewport looks "dead."
3. **Column/band blanks.** Same root cause — at transitional zooms
   some visible tiles exist (the region's column) while neighbouring
   tiles don't, producing a vertical strip of content next to blank
   columns.

The fix shape is a second vector tile source — `world-overview.pmtiles`
— that:

- Covers **z0–z7 globally** with Natural Earth data (country & state
  polygons, ocean/land fill, country/state labels).
- Is built once during bootstrap and served under
  `/api/v1/maps/tiles/_overview/streets.pmtiles`.
- Is always present in the MapLibre style as a second source, with
  world-overview layers gated to `maxzoom: 7` so the per-region
  source takes over at higher zooms where streets exist.

The region's `streets.pmtiles` pipeline is untouched — this is purely
additive. No new runtime network surface: bootstrap owns the build.

---

## How to use this document (Claude Code operating contract)

You are a fresh Claude Code session. You have been pointed at this
file and given no other instructions.

**Do exactly this:**

1. Read the **Status** table below. Pick the **first** chunk whose
   status is `pending` — call it Chunk N.
2. Open `chunk-N-*.md` and read it completely. **Do not open any
   other chunk doc.**
3. Execute every step in its `## Actions` section.
4. Run the command in its `## Verify` section. If it fails, do not
   proceed — diagnose or record the block and stop. Do not fake
   success.
5. If verify passes:
   - Stage only the files the chunk touched.
   - Commit using the template in the chunk's `## Commit message`
     section. Follow `memory/feedback_no_push_without_explicit_ask.md`
     — **commit only; do not push, open a PR, or merge.**
   - Edit this `PLAN.md`: flip the chunk's row from `pending` to
     `done` and paste the commit SHA in the `Commit` column.
   - If during execution you discovered work that had to be pushed
     to a later chunk, append a `## Deferred from Chunk N` bullet
     list to that later chunk's doc with the specifics.
6. **Stop.** Do not begin the next chunk in the same session. Each
   chunk gets its own fresh context.

**If blocked** (verify keeps failing, required file is missing, intent
of the chunk is unclear): leave the chunk status as `pending`, write
a `## Blocker` section at the bottom of that chunk's doc explaining
what's wrong, and stop. Do not guess.

**Scope rule**: only touch files listed in the chunk doc's `## Files`
section. If work sprawls beyond that list, stop and defer the sprawl
to a later chunk.

---

## Status

| # | Chunk                                                                         | Status  | Commit |
|---|-------------------------------------------------------------------------------|---------|--------|
| 1 | [Bootstrap: build world-overview.pmtiles](chunk-1-build-overview-pmtiles.md)  | done    | e4df4ed |
| 2 | [Backend: serve the overview tile file](chunk-2-overview-tile-route.md)       | done    | e4cfc40 |
| 3 | [Frontend: dual-source style + wiring](chunk-3-dual-source-style.md)          | done    | efaa931 |

---

## Global context (read once, applies to every chunk)

### Architectural decision: planetiler only, no tippecanoe

`docs/roadmap/maps-java-stack/PLAN.md` explicitly removed tippecanoe
from the toolchain in favour of a single fat JAR (`planetiler.jar`).
Do not reintroduce tippecanoe, `tilelive`, or any other vector-tile
builder. The world-overview pmtiles is produced by **the same
`planetiler.jar`** that already builds region street tiles.

### The "Monaco hack" for a global NE-only tileset

planetiler's OpenMapTiles profile requires an OSM input file. It does
not expose a "build Natural Earth only" mode. BUT — the profile
emits Natural Earth features at low zoom *regardless* of what is in
the OSM input. So:

- Pass a **tiny OSM extract** (Geofabrik's Monaco, ~800 KB).
- Limit output to `--maxzoom=7`.
- Natural Earth data is emitted globally at z0–z7; Monaco streets are
  also emitted at z0–z7 but occupy a ~2 km² strip on the Mediterranean
  coast — negligible payload, harmless visually.
- Result: a ~20–50 MB pmtiles covering the globe at low zoom with NE
  country/state/water features + labels.

This is a well-understood community pattern. It avoids writing a
custom planetiler profile (which would mean compiling a JAR, adding
a build tool to bootstrap, and shipping it). The trade-off is a tiny
amount of "bonus" Monaco data. Accepted.

### Dual-source style layout

MapLibre supports multiple vector sources in one style. The plan:

| Source           | URL                                                         | Used for                                          |
|------------------|-------------------------------------------------------------|---------------------------------------------------|
| `world_overview` | `pmtiles:///api/v1/maps/tiles/_overview/streets.pmtiles`    | z0–z7 globally: country/state polygons + labels, ocean fill |
| `protomaps`      | `pmtiles:///api/v1/maps/tiles/<region_id>/streets.pmtiles`  | existing per-region tiles at every zoom          |

Layer paint order (bottom → top):
1. `background` (from palette)
2. `world_overview` land/water/boundary fills (maxzoom 7)
3. `protomaps` water/landuse/roads/buildings (existing, every zoom)
4. `world_overview` country/state symbol labels (maxzoom 7)
5. `protomaps` place labels + street labels + POIs (existing)

Each `world_overview` layer gets `maxzoom: 7` so it stops drawing once
the region source has detailed data. Each `protomaps` layer keeps its
existing `minzoom`/`maxzoom` — unchanged.

### File locations

- Build output: `.lokidoki/tools/planetiler/world-overview.pmtiles`
- Served at: `/api/v1/maps/tiles/_overview/streets.pmtiles`

The `_overview` path segment intentionally starts with an underscore
so it can never collide with a real `region_id` (catalog IDs are
`us-ct`, `gb-eng`, etc. — no underscore prefix). The existing
`get_streets_pmtiles(region_id: str)` handler has a regex
`_validate_region_id` that rejects the underscore form, so the new
route is a **separate handler** — not a parameterised reuse.

### Reused pins (already in `versions.py`)

- `NATURAL_EARTH` — sqlite, pinned by chunk 2 of the offline-hardening
  plan. Already on disk after `install-planetiler-data`.
- `OSM_WATER_POLYGONS` — zip, pinned by the same chunk.
- `PLANETILER` — the 0.8.4 fat JAR.
- `TEMURIN_JRE` — the 21 LTS JRE.

### New pin introduced by chunk 1

- `MONACO_PBF` — Geofabrik's `monaco-latest.osm.pbf`. Upstream serves
  a mutable URL (daily rebuild); pin hard with sha256 and refresh only
  on deliberate update, same discipline as NE / water polygons.

### What stays untouched

- Per-region install pipeline (`download_pbf`, `building_streets`,
  `building_routing`, `building_geocoder`). Unrelated.
- Glyph preflight and `/api/v1/maps/glyphs/...` route. Unrelated.
- GraphHopper routing. Unrelated.
- Region tile serving (`/api/v1/maps/tiles/<region_id>/streets.pmtiles`).
  Unchanged.

### Non-goals

- **Not** a full world basemap. We are NOT trying to render world
  streets / POIs / buildings. Only what Natural Earth gives us at
  low zoom: countries, states, oceans, continents, major places.
- **Not** a zoom > 7 global layer. Past z7 the user is either inside
  an installed region (region tiles paint) or looking at empty space
  outside coverage (correct offline behaviour — out-of-coverage
  banner already exists).
- **Not** a mechanism for installing *new* regions. Bootstrap builds
  `world-overview.pmtiles` once; re-running bootstrap is the refresh
  path, same as every other pinned artifact.

---

## NOTE (append as chunks land)

- **Post-chunk-3 bounds fix:** chunk 1's planetiler invocation omitted
  `--bounds`, which caused planetiler to clip NE + water polygons to
  the OSM input's bbox (Monaco, ~2 km²). First end-to-end build
  produced a 45 KB pmtiles with zero global coverage instead of the
  ~11 MB global basemap. Fix: pass `--bounds=-180,-85,180,85` in
  `lokidoki/bootstrap/preflight/world_overview.py`. Regression guarded
  by `test_preflight_world_overview.py::test_happy_path_...`. Landed in
  the chunk-3 deferral-closeout commit (not chunk 1's original commit).
