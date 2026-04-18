# Chunk 1 — PMTiles infrastructure + protocol wiring

## Goal

Wire MapLibre GL to the `pmtiles://` protocol so a locally-served `.pmtiles` file can render as a vector basemap. Swap the current OSM raster URL for a Protomaps vector style that can be fed either an online HTTPS `.pmtiles` URL (dev) or a local `/api/v1/maps/tiles/<region>` URL (future chunks). **No user-visible feature.** This chunk is pure plumbing — with no region installed, the online Protomaps demo tileset is used and the page looks the same as today.

## Files

- `frontend/package.json` — add `pmtiles` dependency.
- `frontend/src/pages/MapsPage.tsx` — register the protocol at module load, swap the raster style for a vector style ref, keep the existing dark Onyx injection.
- `frontend/src/pages/maps/style-dark.ts` — new: Protomaps basemap schema as a JS object, Onyx-palette colors, one source `protomaps` pointed at a config-driven URL.
- `frontend/src/pages/maps/tile-source.ts` — new: helper that resolves `pmtiles://` URL from `/api/v1/maps/regions` (stub for now — returns `null`, always falls back to the online demo).
- `lokidoki/api/routes/maps.py` — new minimal router: `GET /api/v1/maps/regions` returns `[]`; endpoint stub so the frontend helper has a target. Register the router in `lokidoki/main.py`.
- `tests/unit/test_maps_api_stub.py` — new: asserts `/api/v1/maps/regions` returns `200 []`.

Read-only: `lokidoki/api/routes/archives.py` (mirror route-registration style), `frontend/src/pages/MapsPage.tsx` (top-of-file CSS injection at lines 23–69 stays verbatim).

## Actions

1. `cd frontend && pnpm add pmtiles` — pin to `^3`. Commit the lockfile change.
2. Create `frontend/src/pages/maps/style-dark.ts`. Export a `buildDarkStyle(tileUrl: string): maplibregl.StyleSpecification`. `tileUrl` is a single string — either `pmtiles://https://<demo>` for online dev or `pmtiles:///api/v1/maps/tiles/<region>.pmtiles` for installed regions. Start with the Protomaps basemap layer set (earth, water, roads minor/medium/major, places). Colors pulled from the existing `--elevation-1..4` and purple accent tokens (read them from the current CSS injection).
3. Create `frontend/src/pages/maps/tile-source.ts` exporting `async function resolveTileSource(): Promise<{ kind: "local"; url: string; region: string } | { kind: "online"; url: string }>`. For this chunk: always return `{ kind: "online", url: "pmtiles://https://demo.protomaps.com/basemaps-assets.pmtiles" }`. The backend call to `/api/v1/maps/regions` happens but its empty result is ignored.
4. Edit `frontend/src/pages/MapsPage.tsx`:
   - At module top (next to existing imports): `import { Protocol } from "pmtiles"; import maplibregl from "maplibre-gl"; maplibregl.addProtocol("pmtiles", new Protocol().tile);`. Guard against double-registration on HMR.
   - Replace the raster-tile style literal with `buildDarkStyle((await resolveTileSource()).url)`.
   - Keep the CSS injection (lines 23–69) and the current search box / marker behavior byte-for-byte. Do not change geocoding in this chunk — Nominatim still runs.
5. Create `lokidoki/api/routes/maps.py`:
   ```python
   from fastapi import APIRouter
   router = APIRouter(prefix="/api/v1/maps", tags=["maps"])

   @router.get("/regions")
   async def list_regions() -> list[dict]:
       return []
   ```
   Register in `lokidoki/main.py` alongside the archives router — follow the same `app.include_router(...)` pattern.
6. `tests/unit/test_maps_api_stub.py`:
   - `test_list_regions_returns_empty_array`: hit `/api/v1/maps/regions`, assert `200`, assert body `== []`.
   - `test_list_regions_content_type_json`: asserts response `application/json`.

## Verify

```bash
uv run pytest tests/unit/test_maps_api_stub.py -x && \
cd frontend && pnpm tsc --noEmit && pnpm build && cd .. && \
uv run python -c "
from fastapi.testclient import TestClient
from lokidoki.main import app
c = TestClient(app)
r = c.get('/api/v1/maps/regions')
assert r.status_code == 200 and r.json() == [], r.text
print('maps stub OK')
"
```

Browser smoke (manual, document in commit body if possible): `./run.sh`, open `http://localhost:8000/maps`, confirm the map renders from the Protomaps demo `.pmtiles` (vector, not raster). Network tab should show `.pmtiles` byte-range requests, not `.png` tiles. If it still shows PNGs, the protocol registration is broken — fix before committing.

## Commit message

```
feat(maps): wire PMTiles protocol + Protomaps vector style

MapLibre now registers the pmtiles:// protocol at module load and
renders the dark Onyx basemap from a vector style (Protomaps schema)
instead of raster OSM PNGs. No region is installed yet, so the
frontend falls back to the Protomaps demo tileset — same observable
behavior as before, vector under the hood.

Adds a minimal /api/v1/maps/regions router returning []. Later chunks
populate it from an on-disk catalog and swap the tile source URL to a
local /api/v1/maps/tiles/<region>.pmtiles.

Refs docs/roadmap/offline-maps/PLAN.md chunk 1.
```

## Deferrals section (append as you discover)

*(empty — append `## Deferred to Chunk N` blocks here if sprawl arises)*
