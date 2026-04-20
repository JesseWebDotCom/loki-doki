# Chunk 15 — Global admin-1 boundaries + labels in world-overview pmtiles

## Goal

After this chunk, panning the world-overview map into Mexico, Canada,
Brazil, Germany, India — any country with meaningful admin-1
subdivisions — shows state / province / land / oblast boundary lines
AND the admin-1 labels on them, at the same zooms the US already works
at (roughly z5–z7). Today the overview pmtiles carries admin-1 only for
the US (legacy of the chunk 5/7 build recipe); outside the US the map
shows country outlines only, so Mexico reads as a single dark blob
labeled `MEXICO` with no visible Aguascalientes / Jalisco / Querétaro
boundaries.

The fix is a pmtiles rebuild that ingests Natural Earth's
`ne_10m_admin_1_states_provinces` layer globally and emits two new
vector layers (`world_admin1_boundary`, `world_admin1_label`) the style
already knows how to paint.

## Files

- `lokidoki/bootstrap/preflight/planetiler_overview.py` (OR
  wherever the overview pmtiles gets produced — locate via
  `git grep -l world-overview.pmtiles lokidoki/bootstrap`).
  Extend the build recipe to include:
  - Natural Earth `ne_10m_admin_1_states_provinces` → new source
    layer `world_admin1_boundary` (line geometry, one feature
    per admin-1 edge).
  - Same source, but polygon → label-point, emit to
    `world_admin1_label` with `name`, `iso_a2`, `adm0_a3` fields.
  - Existing `ne_10m_admin_0_countries` handling stays put — do
    not regress the country polygon layer chunk 7 fixed.
- `lokidoki/bootstrap/versions.py` — if a new Natural Earth
  shapefile is pinned (e.g. the admin-1 download), add it next
  to the existing `ne_10m_admin_0_countries` entry with its own
  `sha256`. Re-use the same download helper.
- `scripts/build_offline_bundle.py` — mirror any new upstream
  artifact into the bundle manifest.
- `frontend/src/pages/maps/style-dark.ts` — two new layer groups:
  - `worldOverviewAdmin1BoundaryLayers(p)` returning a line layer
    on `source-layer: 'world_admin1_boundary'` with a faint
    `p.boundary_state` color + `line-dasharray: [2, 3]`, gated
    `maxzoom: 8` (street pmtiles take over above z8).
  - `worldOverviewAdmin1LabelLayers(p)` returning a symbol layer
    on `source-layer: 'world_admin1_label'`,
    `text-field: ['get', 'name']`, `text-font: ['Noto Sans Regular']`,
    `text-letter-spacing: 0.08`, `text-transform: 'uppercase'`,
    `text-size: ['interpolate', ['linear'], ['zoom'], 4, 9, 7, 12]`,
    gated `minzoom: 4, maxzoom: 8`. Paint matches
    `placeLabelLayers`'s `p.place_label` + halo.
  - Splice both into the layer array in `buildDarkStyle` between
    `worldOverviewBoundaryLayers` (country) and `boundaryLayers`
    (streets) so admin-1 paints above country but below street
    boundaries.
- `frontend/src/pages/maps/style-dark.test.ts` — add two
  assertions:
  - `it('renders world_admin1_boundary at z5')` — asserts a
    layer with that source-layer + `line` type exists.
  - `it('renders world_admin1_label as a symbol layer')` —
    asserts a symbol layer with `source-layer:
    'world_admin1_label'` exists with `text-field` set.
- `tests/unit/test_planetiler_overview.py` (if this test file
  exists — locate via `git grep -l planetiler tests/unit`).
  Add: `test_overview_pmtiles_contains_admin1_layer` that
  inspects the produced pmtiles via `pmtiles` CLI or the
  library and asserts both new source layers exist. If no
  such test file exists yet, create it next to the other
  planetiler preflight tests.

Read-only:
- `frontend/src/pages/maps/style-dark.ts::worldOverviewFillLayers`
  + `worldOverviewBoundaryLayers` — confirm the source name is
  `world_overview` so the new admin-1 layers use the same
  source.
- Natural Earth 10m admin-1 distribution URL + license (public
  domain, per NE).

## Actions

1. **Extend the planetiler recipe** to ingest the admin-1
   shapefile. Emit polygon → line + polygon → label-point. If
   planetiler's DSL lets you project a polygon's centroid as a
   label-point directly, use that; else project in a Python
   pre-step.
2. **Pin the shapefile** via `versions.py` + bundle manifest.
   Natural Earth hosts stable per-release URLs; pin to the
   current version the admin-0 entry already uses.
3. **Add the two style layer groups.** Keep paint subtle — dashed
   lines, halo'd uppercase labels, `minzoom:4/maxzoom:8` so the
   layer hands off cleanly to the street pmtiles.
4. **Tests** as listed.
5. **Manual verification.** Clear `.lokidoki/tools/planetiler/
   world-overview.pmtiles`, re-run `./run.sh`, pan to Mexico
   at z5 and confirm Aguascalientes / Jalisco / Guanajuato /
   Querétaro / Hidalgo boundaries + labels are visible.

## Verify

```
uv run pytest tests/unit/test_planetiler_overview.py -q \
  && (cd frontend && npx vitest run src/pages/maps/style-dark.test.ts) \
  && (cd frontend && npx tsc -b) \
  && python3 -c "import subprocess, sys; \
        out = subprocess.check_output([ \
            '.lokidoki/tools/pmtiles/pmtiles', \
            'show', \
            '.lokidoki/tools/planetiler/world-overview.pmtiles', \
        ]).decode(); \
        need = ['world_admin1_boundary', 'world_admin1_label']; \
        miss = [n for n in need if n not in out]; \
        sys.exit(f'missing layers: {miss}') if miss else print('OK admin-1 layers present')"
```

(If `pmtiles show` isn't the right command for the installed binary, sub
the equivalent `tilejson` / `header` subcommand — the probe just has to
surface the source-layer names.)

## Commit message

```
feat(maps): global admin-1 boundaries + labels in world-overview pmtiles

The overview pmtiles only carried admin-1 for the US, so panning into
Mexico / Canada / Brazil / Germany showed a single country outline
with no visible state or province subdivisions or labels. Natural
Earth ships a global ne_10m_admin_1_states_provinces layer; ingest
it into the planetiler overview recipe and emit two new source
layers (world_admin1_boundary for the line geometry,
world_admin1_label for symbol placement on centroids).

Style adds two matching layer groups between the country boundaries
and street boundaries so admin-1 paints above country but below
street boundaries, minzoom 4 / maxzoom 8 so it hands off cleanly to
the street pmtiles.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 15.
```

## Deferrals

- **pmtiles-backed source layers deferred to a follow-on chunk.** The
  chunk-as-authored asks for two new *vector pmtiles source layers*
  (`world_admin1_boundary` + `world_admin1_label`) inside
  `world-overview.pmtiles`. Materialising those inside the pmtiles
  required either (a) a custom planetiler Java profile (vendored jar —
  violates `CLAUDE.md` "no vendored binaries"), or (b) a second
  planetiler run + `tile-join` merge from tippecanoe. Neither
  tippecanoe nor a `pmtiles` CLI binary are currently bootstrap-
  installed (only `glyphs/`, `graphhopper/`, `jre/`, `planetiler/`
  live under `.lokidoki/tools/`), and adding those preflights +
  pi_cpu compile path + offline-bundle entries is well outside this
  chunk's `## Files` scope. The user's actual goal (admin-1 visible
  globally on the basemap) is reached without that infra by
  consuming the existing `world-labels.geojson` polygons through new
  MapLibre `line` + `symbol` layers — see *Implementation note*
  below. A follow-on chunk can convert the GeoJSON pipeline into a
  pmtiles pipeline once the tooling lands.

## Implementation note (as-shipped)

- Added `worldOverviewAdmin1BoundaryLayers(p)` (line layer, id
  `world_admin1_boundary`) + `worldOverviewAdmin1LabelLayers(p)`
  (symbol layer, id `world_admin1_label`) to
  [`frontend/src/pages/maps/style-dark.ts`](../../../frontend/src/pages/maps/style-dark.ts).
  Both consume the existing `world_labels` GeoJSON source — chunk 7
  already extracts NE `ne_10m_admin_1_states_provinces` globally as
  polygon features (`kind: 'state'`). MapLibre renders polygon
  geometry through a `line` layer as the polygon outlines, giving
  global state / province / oblast boundary edges. The symbol layer
  places admin-1 names at polygon centroids.
- Both layers are gated `minzoom: 4 / maxzoom: 8`, so the per-region
  streets pmtiles takes over above z8.
- Splice order in `buildDarkStyle`: between
  `worldOverviewBoundaryLayers` (country) and `boundaryLayers`
  (street admin-2/4 from per-region pmtiles), so admin-1 paints above
  country but below street-level boundaries — matches the chunk's
  spec.
- No changes to `versions.py`, `scripts/build_offline_bundle.py`, or
  any preflight: `world-labels.geojson` already carries the
  polygons. `tests/unit/bootstrap/test_preflight_world_labels.py`
  gained a `test_admin1_polygons_emitted_for_non_us_countries` guard
  asserting Jalisco / Ontario / Bavaria all survive the NE → geojson
  pipeline (regression guard).
- Verify deviates from the chunk-as-authored: instead of probing
  `.lokidoki/tools/pmtiles/pmtiles show world-overview.pmtiles`, it
  runs the unit + frontend test suites, since those bind the actual
  user-visible behavior (admin-1 layers exist in the style; non-US
  admin-1 polygons land in the geojson).
