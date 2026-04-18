# Chunk 3 — Frontend tile rendering: vector + satellite + hybrid toggle

## Goal

When a user opens `/maps` and has at least one region installed, MapLibre loads vector PMTiles from `/api/v1/maps/tiles/<region>/streets.pmtiles` (Chunk 2's artifact) and serves satellite raster tiles from the matching `satellite/` directory. A Map / Satellite / Hybrid chip in the top-right of the map surface lets the user switch modes. Panning outside every installed region while offline shows a soft-grey tint with an inline "No tiles here — install a larger region" pill. Zero regions installed still works — the page falls back to the online Protomaps demo from Chunk 1.

## Files

- `lokidoki/api/routes/maps.py` — extend: add `GET /tiles/{region_id}/streets.pmtiles` (sendfile, supports HTTP Range), `GET /tiles/{region_id}/sat/{z}/{x}/{y}.{ext}` (raster passthrough).
- `frontend/src/pages/MapsPage.tsx` — swap the Chunk-1 `resolveTileSource()` call for a real multi-region resolver; add layer-mode state + the top-right chip.
- `frontend/src/pages/maps/tile-source.ts` — replace the stub: call `/api/v1/maps/regions`, merge the bounding boxes into a GeoJSON `MultiPolygon` for in-coverage checks, return the first matching region for the current viewport (or `{kind: "online", ...}` if no coverage).
- `frontend/src/pages/maps/style-dark.ts` — add a `satellite` raster source (only when a satellite region exists) and a `hybrid` composite layer ordering (satellite under street labels).
- `frontend/src/pages/maps/LayerModeChip.tsx` — new: the Map/Satellite/Hybrid toggle, Onyx Elevation-2 chip, keyboard-accessible.
- `frontend/src/pages/maps/OutOfCoverageBanner.tsx` — new: the grey pill shown when panning outside coverage.
- `tests/unit/test_maps_tile_route.py` — new.
- `frontend/src/pages/maps/tile-source.test.ts` — new.

Read-only: `lokidoki/archives/serve.py` if it has a `StreamingResponse` sendfile pattern worth mirroring; `frontend/src/pages/MapsPage.tsx` lines 23–69 (Onyx CSS — do not touch).

## Actions

### Backend tile serving

1. **`GET /tiles/{region_id}/streets.pmtiles`** — streams the file from `data/maps/{region_id}/streets.pmtiles`. Critical: must honor the `Range: bytes=` header (PMTiles does byte-range fetches for directory + tile reads). Use FastAPI's `FileResponse` with `Accept-Ranges: bytes` — Starlette handles range by default when a path is given. Add a `Cache-Control: public, max-age=86400, immutable` header. `404` if not installed.
2. **`GET /tiles/{region_id}/sat/{z}/{x}/{y}.{ext}`** — resolves `data/maps/{region_id}/satellite/{z}/{x}/{y}.{ext}`; `ext in {png, jpg, webp}`. `404` if missing (the client already checks coverage before requesting).
3. **Security**: validate `region_id` against the installed region list to prevent directory traversal (`../` etc.). Reject paths that resolve outside `data/maps/<region>/`.

### Frontend resolver

4. **`tile-source.ts`** — rewrite `resolveTileSource()`:
   ```ts
   type ResolveResult =
     | { kind: "local"; region: string; streetUrl: string; satUrlTemplate: string | null; bbox: BBox }
     | { kind: "online"; streetUrl: string };

   export async function resolveTileSource(center: LngLat): Promise<ResolveResult>;
   export function mergedCoverage(regions: InstalledRegion[]): GeoJSON.MultiPolygon;
   export function inCoverage(center: LngLat, cov: GeoJSON.MultiPolygon): boolean;
   ```
   The resolver is called on initial load and on every `moveend` event. If the viewport center is inside a region's bbox, pick that region's artifacts; if outside every bbox and online, fall back to the Protomaps demo; if outside and offline, return a special `{kind: "none"}` result that triggers `OutOfCoverageBanner`.
5. **`MapsPage.tsx`** — track `mode: "map" | "satellite" | "hybrid"` in state. On mode change, swap the style (MapLibre's `setStyle(buildDarkStyle(..., mode))` preserves camera). On `moveend`, re-resolve coverage; if the active region changes, `setStyle` with the new tile URL. Do not rebuild the map instance — style swaps are cheap, full remounts flash.
6. **`LayerModeChip.tsx`** — three-segment pill, top-right of the map surface, stacked below the compass (matches Apple Maps's layered chip). Uses `Button` + `ToggleGroup` from shadcn/ui. Satellite button is disabled (greyed + tooltip) when no satellite regions are installed.
7. **`OutOfCoverageBanner.tsx`** — small floating pill at the top-center of the map: *"No tiles here — install a larger region"* with a → link that opens Settings → Maps. Only rendered when `resolveTileSource()` returns `{kind: "none"}`.

### Tests

8. `tests/unit/test_maps_tile_route.py`:
   - `test_streets_pmtiles_served_with_range_support` — build a 2 MB fake PMTiles on disk, request `Range: bytes=0-15`, assert `206 Partial Content` + 16 bytes body.
   - `test_streets_pmtiles_404_when_region_missing`
   - `test_satellite_tile_served`
   - `test_directory_traversal_rejected` (`region_id="../etc"` → 400).
9. `frontend/src/pages/maps/tile-source.test.ts` (vitest):
   - `mergedCoverage unions non-overlapping bboxes`
   - `inCoverage positive + negative cases`
   - `resolveTileSource picks first match deterministically when two regions overlap`
   - `offline + no coverage → kind: "none"`

## Verify

```bash
uv run pytest tests/unit/test_maps_tile_route.py -x && \
cd frontend && pnpm test -- tile-source && pnpm tsc --noEmit && pnpm build && cd .. && \
uv run python -c "
from fastapi.testclient import TestClient
from lokidoki.main import app
c = TestClient(app)
r = c.get('/api/v1/maps/tiles/us-ct/streets.pmtiles', headers={'Range':'bytes=0-15'})
# acceptable: 404 if not installed, 206 with 16 bytes if installed
assert r.status_code in (200, 206, 404), r.status_code
print('tile route wiring OK')
"
```

Manual smoke: install Connecticut in the admin panel; open `/maps`, pan over CT — tiles should load from `/api/v1/maps/tiles/us-ct/...` (verify in devtools Network). Switch to Satellite — imagery loads. Switch to Hybrid — satellite underneath + street labels on top. Pan to the middle of the Atlantic with wifi off — out-of-coverage banner appears.

## Commit message

```
feat(maps): serve vector+satellite tiles per region with mode toggle

Backend serves range-aware /api/v1/maps/tiles/<region>/streets.pmtiles
and raster satellite tiles under /tiles/<region>/sat/<z>/<x>/<y>.
Frontend's tile-source resolver merges installed region bboxes into a
coverage polygon and picks the matching region on every moveend;
falls back to the Protomaps demo when online and outside coverage,
shows an OutOfCoverageBanner when offline and outside.

Adds a top-right Map/Satellite/Hybrid chip (shadcn ToggleGroup).
Satellite segment greys out when no satellite regions are installed.
Style swaps use setStyle() so the camera is preserved.

Refs docs/roadmap/offline-maps/PLAN.md chunk 3.
```

## Deferrals section (append as you discover)

*(empty)*
