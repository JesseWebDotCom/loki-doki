# Chunk 8 — Offline-maps deferrals rollup

## Goal

Track the seven outstanding deferrals logged during Chunks 1–7. This
chunk is **authoring-only** on its own — it just registers the backlog
in one place so future fresh sessions can execute each item as a
stand-alone sub-chunk. Every item below has its own `## Sub-chunk …`
block with its own `Files` / `Actions` / `Verify` so a future session
can pick one, finish it, and flip its status in the Sub-status table.

When every sub-chunk under this rollup is `done`, the offline-maps
plan is fully shipped and Chunk 8 can itself flip to `done` on
[PLAN.md](PLAN.md).

---

## Sub-status

| # | Sub-chunk                                                  | Status  | Commit |
|---|------------------------------------------------------------|---------|--------|
| 8a | Chunk-6 deferral — install artifact host + dist override  | done    | _(staged)_ |
| 8b | Chunk-6 deferral — cross-region routing                   | pending |        |
| 8c | Chunk-6 deferral — offline `find_nearby` (POI extractor)  | pending |        |
| 8d | Chunk-7 deferral — `Leave at…` / `Arrive by…` depart time | pending |        |
| 8e | Chunk-7 deferral — transit directions (GTFS per region)   | pending |        |
| 8f | Chunk-7 deferral — live voice navigation (GPS + reroute)  | pending |        |
| 8g | Chunk-2 deferral — formalise admin-panel wiring           | pending |        |

---

## Global context (applies to every sub-chunk)

- Region catalog lives in [lokidoki/maps/seed.py](../../../lokidoki/maps/seed.py); URL templates all derive from `_DIST = "https://dist.lokidoki.app/maps"` and `_GEOFABRIK`.
- Install pipeline is [lokidoki/maps/store.py::install_region](../../../lokidoki/maps/store.py); progress is piped to the SSE route in [lokidoki/api/routes/maps.py](../../../lokidoki/api/routes/maps.py).
- Admin UI for install lives at [frontend/src/components/settings/MapsSection.tsx](../../../frontend/src/components/settings/MapsSection.tsx); a red banner now surfaces per-region errors (Chunk-8 prework landed in `f73d880`).
- Valhalla wrapper is [lokidoki/maps/routing/valhalla.py](../../../lokidoki/maps/routing/valhalla.py).
- Directions panel is [frontend/src/pages/maps/panels/DirectionsPanel.tsx](../../../frontend/src/pages/maps/panels/DirectionsPanel.tsx); routing hook is [use-directions.ts](../../../frontend/src/pages/maps/panels/use-directions.ts).
- Scope rule still applies: **only touch files a sub-chunk's `## Files` list names.**

---

## Sub-chunk 8a — Install artifact host + dist override

**Source:** Chunk 6 deferral — _"Offline-bundle build host + publishing pipeline … this chunk consumes prebuilt Valhalla tarballs + per-region tile archives from a CDN URL; it does not implement the build host that produces them."_

### Goal

Unblock the install flow for self-hosters even before the real
`dist.lokidoki.app` bucket exists. Make the base URL configurable,
teach the admin UI to detect a default/unset dist host and explain
what's needed, and extend
[scripts/build_offline_bundle.py](../../../scripts/build_offline_bundle.py)
to produce per-region artifacts into a local directory that can be
served over HTTP.

### Files

- `lokidoki/maps/seed.py` — replace `_DIST` with a lookup that honours
  `LOKIDOKI_MAPS_DIST_BASE` (env var) with a sane fallback.
- `lokidoki/maps/catalog.py` — expose `dist_base()` helper + unit
  hook for tests.
- `lokidoki/api/routes/maps.py` — surface the active dist base in
  `GET /api/v1/maps/storage` so the UI can tell when it's the stub.
- `frontend/src/components/settings/MapsSection.tsx` — render an
  orange notice when `dist_base` equals the stub and no regions are
  installed.
- `scripts/build_offline_bundle.py` — new `--maps <region_id…>` flag
  that runs the per-region artifact build (reuses the existing
  publish layout).
- `tests/unit/test_maps_catalog.py` — assert env-override behaviour.
- `docs/maps-dist.md` (new) — 1-page guide: "How to host your own
  offline-maps artifacts."

### Actions

1. Introduce `DIST_BASE_ENV = "LOKIDOKI_MAPS_DIST_BASE"` and a
   `dist_base()` helper in `catalog.py` that returns
   `os.environ.get(DIST_BASE_ENV, "https://dist.lokidoki.app/maps")`.
2. Rewrite `_DIST` usage in `seed.py` to call `dist_base()` at
   `build_catalog()` time (catalog already rebuilds on module load —
   no restart needed).
3. Extend `scripts/build_offline_bundle.py` with a `--maps` command
   that, for each region, downloads the source `.osm.pbf`, runs
   `tippecanoe` for PMTiles and `valhalla_build_tiles` for the
   routing tarball, emits a `sha256` manifest, and writes everything
   under `./lokidoki-offline-bundle/maps/<region_id>/`. Document the
   output layout in `docs/maps-dist.md`.
4. `GET /storage` response gains `dist_base: <url>` so the admin can
   render a "Install source: <url>" hint; add a boolean
   `is_stub_dist` flag based on string equality with the default.
5. Admin banner: when `is_stub_dist && installed.length === 0`,
   render an `AlertTriangle` card pointing at `docs/maps-dist.md`.
6. Add `tests/unit/test_maps_catalog.py::test_dist_base_env_override`.

### Verify

```bash
pytest tests/unit/test_maps_catalog.py -k dist_base -x
LOKIDOKI_MAPS_DIST_BASE=http://localhost:9000/maps \
  python -c "from lokidoki.maps.catalog import dist_base; print(dist_base())"
cd frontend && npm run build && cd ..
```

### Commit message

```
feat(maps): configurable dist base + self-host guide

Unblocks region install for self-hosters before the real CDN exists.
LOKIDOKI_MAPS_DIST_BASE overrides the default dist host; the admin
shows an orange banner when the stub default is active and zero
regions are installed. scripts/build_offline_bundle.py gains a
--maps flag that produces per-region artifacts under
./lokidoki-offline-bundle/maps/.

Refs docs/roadmap/offline-maps/PLAN.md chunk 8a.
```

---

## Sub-chunk 8b — Cross-region routing

**Source:** Chunk 6 deferral — _"a route from CT to CA across two separately-built tile sets will currently fall back to online OSRM."_

### Goal

Let Valhalla serve a multi-region request from a unioned graph so a
CT↔CA trip routes offline. Either (a) publish a combined tile bundle
per-continent, or (b) teach the Valhalla wrapper to graft adjacent
tile directories.

### Files

- `lokidoki/maps/routing/valhalla.py` — multi-region tile-dir
  resolution + config generation.
- `lokidoki/maps/seed.py` — add `continent_tile_bundle` entries.
- `scripts/build_offline_bundle.py` — produce continent-level
  Valhalla bundles (dependency on 8a).
- `tests/unit/test_valhalla_router.py` — cross-region fixture.

### Actions

1. Extend `MapRegion` with optional `parent_valhalla_region_id`.
2. `valhalla.py::_resolve_tile_dir()` now returns the union of the
   region's own tiles + its parent-continent tiles when present.
3. Document the size tradeoff in the install-confirm modal once a
   continent parent becomes selectable.

### Verify

```bash
pytest tests/unit/test_valhalla_router.py -k cross_region -x
```

### Commit message

```
feat(maps): cross-region routing via continent tile bundles

Adds parent_valhalla_region_id to MapRegion and teaches the Valhalla
wrapper to serve routes from the union of a region's own tiles and
its continent parent's. Eliminates the OSRM fallback for common US
state-to-state queries.

Refs docs/roadmap/offline-maps/PLAN.md chunk 8b.
```

---

## Sub-chunk 8c — Offline `find_nearby`

**Source:** Chunk 6 deferral — _"`find_nearby` offline. Overpass is still used for nearby-category search."_

### Goal

Drop the Overpass dependency. Extract POI points (`amenity=*`,
`shop=*`, …) during FTS5 build and expose `GET /api/v1/maps/nearby`
that answers from the per-region SQLite DB.

### Files

- `lokidoki/maps/geocode/fts_index.py` — add POI row type.
- `lokidoki/maps/geocode/fts_search.py` — `nearby()` spatial query.
- `lokidoki/api/routes/maps.py` — new `/nearby` endpoint.
- `lokidoki/orchestrator/skills/navigation.py` — prefer local
  `/nearby` over Overpass.
- `tests/unit/test_geocode_fts_build.py` — assert POI extraction.
- `tests/unit/test_navigation_skill_local_first.py` — prefer-local
  path.

### Actions

1. Extract POIs during FTS build — reuse the existing pbf parser.
2. Add bounded spatial query with a tag filter.
3. Wire the skill to call local first; Overpass becomes fallback.

### Verify

```bash
pytest tests/unit/test_geocode_fts_build.py tests/unit/test_navigation_skill_local_first.py -x
```

### Commit message

```
feat(maps): offline find_nearby via FTS5 POI index

Extracts amenity/shop POIs during the geocoder build and answers
/api/v1/maps/nearby from the local SQLite DB. Navigation skill
prefers the local path and only falls back to Overpass when no
region covers the query.

Refs docs/roadmap/offline-maps/PLAN.md chunk 8c.
```

---

## Sub-chunk 8d — `Leave at…` / `Arrive by…` depart time

**Source:** Chunk 7 deferral — _"UI ships disabled; backend work to pass a `date_time` into Valhalla is a follow-up."_

### Goal

Enable the already-built `DepartMenu` placeholder. Pass `date_time`
through to Valhalla and pipe predicted ETA through the hook.

### Files

- `frontend/src/pages/maps/panels/DepartMenu.tsx` — real time
  picker.
- `frontend/src/pages/maps/panels/use-directions.ts` — add
  `departAt` / `arriveBy` to the request body.
- `frontend/src/pages/maps/panels/DirectionsPanel.types.ts` — new
  fields.
- `lokidoki/api/routes/maps.py` — accept `date_time` on `/route`.
- `lokidoki/maps/routing/valhalla.py` — translate to Valhalla's
  `date_time` costing option.
- `tests/unit/test_valhalla_router.py` — depart-time fixture.

### Actions

1. Replace greyed menu items with a lightweight shadcn time picker.
2. Thread the chosen ISO timestamp through the hook → API body →
   Valhalla costing options.
3. Adjust `formatEta` to use the supplied arrival target when
   present.

### Verify

```bash
cd frontend && npm test -- DirectionsPanel && cd ..
pytest tests/unit/test_valhalla_router.py -k date_time -x
```

### Commit message

```
feat(maps): Leave at / Arrive by depart-time options

Replaces the DepartMenu placeholder with a real time picker and
threads the selection through useDirections, the maps route body,
and Valhalla's date_time costing. ETA display follows the chosen
arrival target when set.

Refs docs/roadmap/offline-maps/PLAN.md chunk 8d.
```

---

## Sub-chunk 8e — Transit directions

**Source:** Chunk 7 deferral — _"Valhalla supports GTFS-ingested transit but we haven't downloaded any GTFS per region."_

### Goal

Per-region GTFS ingest + `transit` profile in the directions panel.

### Files

- `lokidoki/maps/seed.py` — optional `gtfs_url_template`.
- `lokidoki/maps/store.py` — GTFS artifact in the install plan.
- `lokidoki/maps/routing/valhalla.py` — `multimodal` costing
  support.
- `frontend/src/pages/maps/panels/DirectionsPanel.tsx` — 4th mode
  chip gated on coverage.

### Actions

1. Extend catalog + installer for GTFS.
2. Rebuild Valhalla tiles with `transit_tiles` so the `multimodal`
   costing works.
3. UI: show the transit chip only when the covering region has a
   GTFS artifact installed.

### Verify

```bash
cd frontend && npm test -- DirectionsPanel && cd ..
pytest tests/unit/test_valhalla_router.py -k transit -x
```

### Commit message

```
feat(maps): transit directions via per-region GTFS

Adds an optional GTFS artifact to the region catalog, pipes it into
the Valhalla tile build, and surfaces a transit mode chip in the
Directions panel when the covering region ships GTFS.

Refs docs/roadmap/offline-maps/PLAN.md chunk 8e.
```

---

## Sub-chunk 8f — Live voice navigation

**Source:** Chunk 7 deferral — _"Live voice navigation (rerouting on GPS, continuous spoken instructions) — explicit non-goal in PLAN.md."_

### Goal

Turn the one-shot TTS readout into live navigation: a GPS watcher
drives maneuver-index advancement, speaks each instruction at
maneuver-entry, and re-requests the route when the user strays off
the selected shape.

### Files

- `frontend/src/pages/maps/panels/DirectionsPanel.tsx` — Drive/Walk/
  Cycle → "Go" nav mode.
- `frontend/src/pages/maps/panels/useNavigation.ts` (new) — GPS
  watcher + off-route detection + TTS scheduler.
- `frontend/src/pages/MapsPage.tsx` — camera follow + bearing.
- `frontend/src/utils/VoiceStreamer.ts` — queued-utterance support.

### Actions

1. Add a "Go" button next to the selected RouteAltCard.
2. Watch `navigator.geolocation.watchPosition`; advance the active
   maneuver index when the shape-distance to the current step's end
   drops below 25 m.
3. Trigger a new `/route` fetch when the user is >50 m from the
   nearest point on the selected shape for >5 s.
4. Speak each maneuver's narrative text via VoiceStreamer at
   maneuver-entry.

### Verify

```bash
cd frontend && npm test -- useNavigation DirectionsPanel && cd ..
```

### Commit message

```
feat(maps): live voice navigation with GPS follow + reroute

Adds a Go nav mode that tracks the user's GPS position, advances
the active maneuver, speaks each instruction at maneuver entry, and
re-fetches the route when the user strays >50m for >5s. Camera
follows with bearing.

Refs docs/roadmap/offline-maps/PLAN.md chunk 8f.
```

---

## Sub-chunk 8g — Formalise admin-panel wiring

**Source:** Chunk 2 deferral — two files beyond the chunk's scope received minimal additions; this sub-chunk documents that as intentional.

### Goal

Paper trail only: move the two lines of admin-panel glue from
"ad-hoc additions" to "first-class entries" — keeps Chunk 2's audit
log clean.

### Files

- `frontend/src/admin-panel/sections.ts` — confirm `knowledge-maps`
  entry has an owner comment.
- `frontend/src/admin-panel/AdminPanelPage.tsx` — confirm
  `MapsSection` import is alphabetised.
- `docs/roadmap/offline-maps/chunk-2-region-picker.md` — move the
  "Out-of-scope files touched" block into the chunk's Actions so
  it's no longer a deferral.

### Actions

1. Inspect the two lines, add a `// added by offline-maps chunk 2`
   comment above each.
2. Rewrite the Chunk 2 deferrals block to reference Chunk 8g.

### Verify

```bash
cd frontend && npm run build && cd ..
```

### Commit message

```
docs(maps): promote chunk-2 admin-panel wiring from deferral

Moves the two-line admin-panel integration Chunk 2 added out of
Chunk 2's deferrals section and into its Actions, with explanatory
comments in sections.ts / AdminPanelPage.tsx.

Refs docs/roadmap/offline-maps/PLAN.md chunk 8g.
```

---

## Deferrals section (append as you discover)

*(empty — sub-chunks are themselves the backlog)*
