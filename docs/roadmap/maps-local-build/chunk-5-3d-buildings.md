# Chunk 5 — 3D buildings + pitch/tilt control

## Goal

Replace the satellite affordance (removed in chunks 2 and 4) with an
offline-native aerial experience: a 3D buildings layer rendered by
MapLibre's `fill-extrusion` paint over the OSM `building=*` features
already present in the PMTiles we build in chunk 3. The map chrome
grows a single Map / 3D toggle in `LayerModeChip`; when the user
flips to 3D, the camera tilts, extrusions appear, and the rail stays
fully interactive. Mirror the feel of
[osmbuildings.org](https://osmbuildings.org/) at street zoom.

Zero new downloads, zero licensing, zero extra tooling. The cost is
one tippecanoe flag (chunk 3 needs a tiny follow-up if it dropped
building attributes) and one style-layer spec on the frontend.

## Files

- `lokidoki/maps/build.py` — if chunk 3's tippecanoe command doesn't already preserve `-y height -y building:levels -y min_height -y building` attributes, add them. One-line fix.
- `frontend/src/pages/maps/style-dark.ts` — add a `buildings-3d` layer (`type: "fill-extrusion"`) that reads `height` / `min_height` / `building:levels` from the PMTiles `buildings` source-layer. Gated on the current layer mode.
- `frontend/src/pages/maps/LayerModeChip.tsx` — change from a single-state chip to a Map ↔ 3D toggle.
- `frontend/src/pages/MapsPage.tsx` — bring back the `mode` state (collapsed in chunk 4) as `"map" | "3d"`. Wire it through `buildDarkStyle`. Add a small pitch/tilt control (MapLibre's `NavigationControl` ships a pitch button; enable it). When `mode === "3d"` and the map's current pitch is 0, auto-pitch to 45° as a one-time nudge; let the user drag from there.
- `frontend/src/pages/maps/style-dark.test.ts` (new, if one doesn't exist) — unit test the style builder: with `mode: "3d"`, the returned style includes a `fill-extrusion` layer keyed on the `buildings` source-layer.
- `frontend/src/pages/maps/LayerModeChip.test.tsx` (new) — toggle semantics: clicking flips the `mode`, ARIA state is correct.

Read-only: [docs/roadmap/maps-local-build/chunk-3-install-local.md](chunk-3-install-local.md) — the tippecanoe command spec.

## Actions

1. **Confirm building attributes make it through tippecanoe.** In `build.py::run_tippecanoe`, the command line must include `-y height -y min_height -y building:levels -y building`. Without these, tippecanoe drops unknown attributes and extrusions render as flat boxes. If chunk 3 already has them, leave it; if not, add them here and note the prereq.
2. **`style-dark.ts`**:
   - Add a function argument `mode: "map" | "3d"` (or a boolean `buildings3d`).
   - When 3D: append a `fill-extrusion` layer after roads but before labels:
     ```ts
     {
       id: "buildings-3d",
       type: "fill-extrusion",
       source: "protomaps",
       "source-layer": "buildings",
       minzoom: 14,
       paint: {
         "fill-extrusion-color": "#3a3f4a",
         "fill-extrusion-height": [
           "coalesce",
           ["get", "height"],
           ["*", ["to-number", ["get", "building:levels"]], 3],
           8,
         ],
         "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
         "fill-extrusion-opacity": 0.85,
       },
     }
     ```
   - Small flat-extrusion at z13 so footprints fade in naturally.
3. **`LayerModeChip.tsx`**:
   - Two-option segmented chip (Map / 3D). Lucide icons: `Square` for map, `Box` for 3D.
   - Controlled component: takes `mode` + `onChange`.
   - Removes the `satelliteAvailable` prop (gone after chunk 4).
4. **`MapsPage.tsx`**:
   - Re-introduce `const [mode, setMode] = useState<'map' | '3d'>('map')`.
   - Pass `mode` to `buildDarkStyle(...)` — still called inside the `useEffect` that swaps styles.
   - When `mode` flips to `'3d'` and `map.getPitch() === 0`, call `map.easeTo({ pitch: 45, duration: 600 })`. When flipping back, reset pitch.
   - Ensure `NavigationControl`'s `visualizePitch: true` option is on (adds the pitch reset / toggle).
5. **Tests**:
   - Style builder test runs without a real MapLibre instance — just inspects the returned JSON.
   - Chip test uses `@testing-library/react` and asserts ARIA + callback shape.

## Verify

```bash
cd frontend && npm run build && \
  npm test -- --run style-dark LayerModeChip DirectionsPanel MapsSection && \
  cd ..
pytest tests/unit/test_maps_build.py -x   # tippecanoe attribute flags, if added here
```

Manual smoke: with a region installed (e.g., `us-ct`), open `/maps`,
pan to a dense town centre (e.g., Hartford), zoom to z16, click the
chip's 3D button. The map tilts; buildings extrude. Toggle back; the
view flattens. No network traffic.

## Commit message

```
feat(maps): 3D buildings via fill-extrusion, Map/3D toggle in chip

Replaces the removed satellite affordance with an offline-native 3D
buildings layer. MapLibre renders fill-extrusion over the buildings
source-layer already in our PMTiles; height comes from OSM's
`height` / `building:levels` / `min_height` tags. Zero extra
downloads — the attribute data ships with every install.

LayerModeChip becomes a two-option Map/3D toggle. Flipping to 3D
auto-pitches the camera to 45°; NavigationControl exposes pitch
reset. Attribution is unchanged (OSM).

tippecanoe command (chunk 3) is updated to preserve the building
attributes if it wasn't already.

Refs docs/roadmap/maps-local-build/PLAN.md chunk 5.
```

## Deferrals section (append as you discover)

- **Per-building coloring / shading** — OSMBuildings colors by
  `roof:shape`, `building:colour`, etc. Future polish.
- **Sky layer + atmospheric fog** — MapLibre 3.x supports both for
  a more Apple-Maps-like horizon at tilt. Additive.
- **Pedestrian mode camera follow** — couples with sub-chunk 8f
  (live voice nav) if/when that lands.
