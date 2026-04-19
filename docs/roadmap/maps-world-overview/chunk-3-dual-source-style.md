# Chunk 3 — Frontend: dual-source style + wiring

## Goal

After this chunk, the MapLibre style has **two** vector sources
instead of one:

- `world_overview` → `pmtiles:///api/v1/maps/tiles/_overview/streets.pmtiles`
- `protomaps`      → (existing per-region URL, unchanged)

Country polygons, state polygons, ocean/water fill, and country/state
labels paint from `world_overview` at z0–z7 globally. The per-region
source's existing layers paint on top at every zoom where tiles
exist. Net UX effects:

- At low zoom, panning outside the installed region still shows
  country outlines + labels + ocean fill — no more dead viewport.
- At region zoom (z8+), the region source takes over because its
  layers are gated to their own `minzoom`/`maxzoom` and the overview
  layers stop at `maxzoom: 7`.
- Zoom transitions no longer "blank" — the overview source has a
  tile at every (x, y, z ≤ 7), so there's always something to paint.

Prereq: chunks 1 + 2 done (file built; route serves it). Chunk 3 is
purely client-side — no backend or bootstrap changes.

## Files

- `frontend/src/pages/maps/style-dark.ts`:
  - Extend `buildDarkStyle` signature to accept both tile URLs:
    ```ts
    export function buildDarkStyle(
      tileUrl: string,
      overviewUrl: string,
      opts: DarkStyleOptions = {},
    ): maplibregl.StyleSpecification { ... }
    ```
    Making `overviewUrl` required (not optional) — the overview
    build is mandatory on maps-enabled profiles per chunk 1; the
    UI has no "skip the overview" code path.
  - Add a second source entry:
    ```ts
    sources: {
      protomaps: { type: 'vector', url: tileUrl, ... },
      world_overview: {
        type: 'vector',
        url: overviewUrl,
        attribution:
          '© <a href="https://naturalearthdata.com">Natural Earth</a>',
      },
    }
    ```
  - Add new layer builders that read from the `world_overview`
    source. Each layer MUST carry `maxzoom: 7` so the per-region
    source takes over cleanly:
    - `world_background_fill` — `fill` layer against the overview's
      `landcover` / `land` (whatever planetiler emits from NE land
      polygons — inspect the first produced file's layer names).
      Use the existing `p.residential`-ish palette entry so it
      reads as land vs water without clashing with the bg color.
    - `world_water` — `fill`, overview's `water`/`ocean`, palette
      `p.water`.
    - `world_boundary_country` — `line`, overview's `boundary`
      source-layer, filter `admin_level <= 2`, colour
      `p.boundary_country`.
    - `world_boundary_state` — `line`, overview's `boundary`
      filter `admin_level == 4`, colour `p.boundary_state`.
    - `world_place_country` — `symbol`, overview's `place` with
      `class == country`, minzoom 1, maxzoom 7. Use Noto Sans
      Regular (already bundled).
    - `world_place_state` — `symbol`, overview's `place` with
      `class == state`, minzoom 3, maxzoom 7.
  - **Paint order** (carefully — MapLibre paints bottom-up, and we
    want region data visually on top of overview fills but overview
    labels can coexist with region place labels via the `maxzoom`
    gate):
    1. `bg` (background paint — unchanged)
    2. **New overview fills**: `world_background_fill`, `world_water`
    3. Existing `fillLayers(p)` — region parks / residential /
       water / waterways (unchanged, these only paint where region
       tiles exist)
    4. **New overview boundaries**: `world_boundary_country`,
       `world_boundary_state`
    5. Existing `boundaryLayers(p)` (unchanged)
    6. Existing buildings (2d/3d) (unchanged)
    7. Existing road layers (unchanged)
    8. Existing transportation-name + water/poi labels (unchanged)
    9. **New overview symbols**: `world_place_country`,
       `world_place_state`
    10. Existing `placeLabelLayers(p)` (unchanged)
  - Do **not** modify any existing layer's filter or zoom range.
    Chunk 3 is purely additive on the style side.
- `frontend/src/pages/maps/style-dark.test.ts`:
  - Assert every new layer has `maxzoom: 7`.
  - Assert the returned `style.sources` has both `protomaps` and
    `world_overview` keys.
  - Assert `world_overview.url` equals the URL passed in.
  - Keep all existing assertions passing.
- `frontend/src/pages/MapsPage.tsx`:
  - The overview URL is a single fixed value —
    `pmtiles:///api/v1/maps/tiles/_overview/streets.pmtiles`. Hoist
    it to a module-level `const OVERVIEW_PMTILES_URL` alongside any
    similar constants already in the file.
  - Every `buildDarkStyle(...)` call site now passes
    `OVERVIEW_PMTILES_URL` as the second positional arg. Audit
    every caller (`useEffect` setup, theme toggle, layer-mode
    toggle, etc.) — miss one and that path will throw at runtime.
- `frontend/src/pages/maps/tile-source.ts` + `tile-source.test.ts`:
  - `resolveTileSource` is unchanged — it still resolves the region
    tile URL only. The overview URL is not region-dependent, so it
    lives entirely in the page-level constant.
- Any other consumer of `buildDarkStyle` — grep and update.

Read-only for reference:
- [frontend/src/pages/maps/style-dark.ts](../../../frontend/src/pages/maps/style-dark.ts)
  — current single-source style; mirror layer construction pattern
  exactly.
- [frontend/src/pages/MapsPage.tsx](../../../frontend/src/pages/MapsPage.tsx)
  — every `buildDarkStyle(...)` caller you must update.
- [frontend/src/pages/maps/style-dark.test.ts](../../../frontend/src/pages/maps/style-dark.test.ts)
  — existing style-shape tests.

## Actions

1. Produce a sample `world-overview.pmtiles` locally (chunk 1 must
   already have landed) so you can inspect the actual source-layer
   names planetiler writes for NE-only data. Use the pmtiles
   metadata (`tile-viewer` or `curl <route>/metadata`) to confirm
   layer names — planetiler's OpenMapTiles profile conventionally
   emits `place`, `boundary`, `water`, `landcover`. If any name
   differs from the chunk's assumption, update the layer filter
   and note it in `## Deferrals`.
2. Refactor `buildDarkStyle` signature to accept `overviewUrl`. Add
   the `world_overview` source and the six new layers. Respect the
   paint-order list above.
3. Update every `buildDarkStyle(...)` call site in `MapsPage.tsx`
   (grep `buildDarkStyle` under `frontend/src/` — there should be
   1–3 callers, all in the maps page today).
4. Extend `style-dark.test.ts` with the dual-source assertions.
5. Do NOT touch `tile-source.ts` beyond what this chunk needs — its
   job is still to pick the region URL.
6. Run the build end-to-end; a zoom-out from CT to z3 must now
   render visible land/ocean/country boundaries outside CT's bbox.

## Verify

```bash
# Vite build must pass — strict TS will catch the new required arg.
(cd frontend && ../.lokidoki/node/bin/npm run build)

# Unit tests.
(cd frontend && ../.lokidoki/node/bin/npm test -- --run src/pages/maps/style-dark.test.ts)

# Manual smoke test (required — the visual outcome is the whole
# point of the plan):
# 1. Start the app: ./run.sh
# 2. Open /maps
# 3. Zoom all the way out — should see world land/ocean + country
#    labels globally. Zoom to ~z4 over North America — state
#    borders + state labels visible outside CT.
# 4. Zoom IN to Hartford — region tiles paint streets; no visible
#    seams between overview and region layers.
# 5. Pan off CT at z3 — should NOT see a blank viewport; overview
#    stays lit across the whole world.
```

## Commit message

```
feat(maps): dual-source style with world-overview basemap

buildDarkStyle now takes a second required `overviewUrl` and emits
a MapLibre style with two vector sources. `world_overview` paints
country/state polygons + country/state labels + ocean fill globally
at z0-7; the existing `protomaps` source continues to paint the
installed region at every zoom. Overview layers carry maxzoom=7 so
the region source takes over cleanly at street zoom.

Solves the three "blank-outside-region" issues observed on the
live map: (1) country/state labels now render globally, (2) zoom
transitions no longer produce a blank viewport, (3) mid-zoom column
gaps are filled by the overview tiles.

Refs docs/roadmap/maps-world-overview/PLAN.md chunk 3.
```

## Deferrals section (append as you discover)

- ~~Source-layer names unverified against a live pmtiles file.~~
  **Resolved.** Rebuilt `world-overview.pmtiles` locally, inspected the
  embedded `vector_layers` metadata: emitted layers are `boundary`,
  `landcover`, `landuse`, `mountain_peak`, `place`, `transportation`,
  `water`, `waterway`. Every source-layer the chunk-3 style references
  is present.
- ~~Manual in-browser smoke test.~~ **Partially resolved via HTTP.**
  Bootstrap built the 11 MB file, the FastAPI route serves it (GET
  returns `206` + correct PMTiles magic on a Range request). A full
  visual smoke in a browser remains the canonical sign-off but is
  human-in-loop and cannot be run from an agent shell.
- **Cross-chunk fix (chunk 1):** the original preflight omitted an
  explicit `--bounds`. Planetiler then derives bounds from the OSM
  input — Monaco's ~2 km² — so NE + water polygons were clipped
  globally, producing a 45 KB pmtiles with zero global coverage. Fixed
  in this chunk's follow-up commit by passing `--bounds=-180,-85,180,85`.
  Test in `test_preflight_world_overview.py` updated to guard the
  regression.
