# Chunk 4 — Frontend cleanup (phases, satellite removal, stub banner)

## Goal

The admin Maps tab and the `/maps` empty-state speak the new flow.
The orange "Install source is the stub default" banner from
sub-chunk 8a is deleted (its backend fields are already gone after
chunk 2). The Satellite tab is removed entirely — the backend no
longer supports it after chunk 2, and chunk 5 replaces its role
with a 3D buildings toggle. Per-region rows show human progress
labels for each build phase (`Downloading OSM data`, `Indexing
addresses`, `Building vector tiles`, `Building road graph`) with
the existing percent indicator plus a time estimate so users don't
abandon during the multi-minute tippecanoe stage.

The `LayerModeChip` shrinks to just `Map` — chunk 5 adds a `3D`
option on top.

## Files

- `frontend/src/components/settings/MapsSection.tsx` — remove `distBase` / `isStubDist` state + the `showStubBanner` JSX + the 8a reload-helper call that fetches `/storage`. Remove the Satellite tab + the satellite warning banner + the satellite-specific checkbox in every `RegionRow`. Collapse `Tab = "street" | "satellite"` to a single-tab (or no-tab) layout. Add `labelForPhase` + per-phase ETA hints to the progress chip.
- `frontend/src/components/settings/MapsSection.helpers.ts` — drop satellite-related helpers (`aggregateSize`'s satellite branch, any `SelectionMap[string].satellite`). Add `labelForPhase(phase: string): string` + `estimateForPhase(phase, regionSizeMb): string`.
- `frontend/src/components/settings/MapsSection.helpers.test.ts` — drop satellite assertions; add coverage for the two new helpers.
- `frontend/src/pages/maps/tile-source.ts` — drop `satUrlTemplate` + `has_satellite` from `InstalledRegion`, `ResolveResult.local`, and the fetch parser.
- `frontend/src/pages/maps/LayerModeChip.tsx` — drop `satellite` + `hybrid` modes; chip now shows a single `Map` state (chunk 5 re-introduces it as a toggle).
- `frontend/src/pages/maps/style-dark.ts` — remove satellite raster source + layer generation.
- `frontend/src/pages/MapsPage.tsx` — drop `satelliteAvailable` state + its `useMemo`; the `mode` local becomes unused once satellite is gone (chunk 5 brings it back for 3D). For this chunk, delete the `LayerModeChip` render call (chunk 5 re-adds it). Drop the `docs/maps-dist.md` paragraph from `NoRegionsEmptyState`; replace with: "First install downloads ~25 MB for a small state, then builds tiles on-device (2–8 min). No internet needed after."
- `frontend/src/pages/maps/tile-source.test.ts` — drop satellite assertions.

Read-only: [chunk-3-install-local.md](chunk-3-install-local.md) — authoritative phase names.

## Actions

1. `MapsSection.tsx`:
   - Delete `distBase`, `isStubDist`, their `useState`, the `/storage` fetch in `reload()`, the `anyInstalled` / `showStubBanner` computed, and the stub-banner JSX.
   - Delete the `Tab` enum (`"street" | "satellite"`), the `<TabButton>` pair, and the satellite warning banner that appeared when `showSatellite`.
   - Remove the satellite checkbox from every `RegionRow`. Keep only the street checkbox (or collapse to a single select if the UI makes more sense that way).
   - Keep the per-region `errors` banner from `f73d880`.
   - Extend the progress chip to show `<phase label> · NN%`. Wire `labelForPhase(progress.phase)`.
   - Below the percent, when a row is installing and the phase is `building_streets` or `building_routing`, show a muted time-estimate line (`~N min remaining`) derived from `estimateForPhase`.
2. `MapsSection.helpers.ts`:
   - `SelectionMap[string]` becomes `{ street: boolean }` (drop `satellite`).
   - `aggregateSize` sums only street + valhalla bytes. (Satellite column is gone from the catalog payload entirely.)
   - `changedRegions` logic drops the satellite diff.
   - `labelForPhase`: `downloading_pbf` → "Downloading OSM data", `building_geocoder` → "Indexing addresses", `building_streets` → "Building vector tiles", `building_routing` → "Building road graph", `complete` → "Done", unknown → raw.
   - `estimateForPhase(phase, sizeMb)` returns human strings using the Pi-5 timings from `PLAN.md`'s footprint table (multiply by 0.3 for mac; the helper takes the current profile as an arg or assumes worst-case).
3. `tile-source.ts`:
   - `InstalledRegion` drops `has_satellite`.
   - `ResolveResult` local variant drops `satUrlTemplate`.
   - The `/api/v1/maps/regions` parser no longer reads `state.satellite_installed`.
4. `LayerModeChip.tsx`:
   - For this chunk, remove the `Satellite` / `Hybrid` buttons. The chip renders a single static `Map` label (chunk 5 turns it into a Map/3D toggle).
   - Alternatively, delete the component's render in `MapsPage.tsx` for this chunk and let chunk 5 re-add it. Either works; pick the less churny path.
5. `style-dark.ts`:
   - Drop the raster satellite source + `satellite` layer generation.
   - `buildDarkStyle` signature loses `satelliteUrlTemplate`.
6. `MapsPage.tsx`:
   - Drop `satelliteAvailable` + its `useMemo`.
   - Drop the `mode` state (or keep + set default to `"map"` for chunk 5 to re-use).
   - Rewrite the `NoRegionsEmptyState` footer paragraph per Files note.
7. Tests:
   - `MapsSection.helpers.test.ts`: drop satellite, add phase-label + estimate coverage.
   - `tile-source.test.ts`: drop `has_satellite` from the `region()` fixture factory; remove the satellite assertions.

## Verify

```bash
cd frontend && npm run build && npm test -- --run MapsSection DirectionsPanel route-layer tile-source && cd ..
grep -r "LOKIDOKI_MAPS_DIST_BASE\|dist_base\|isStubDist\|showStubBanner\|maps-dist.md" frontend/src/ && exit 1 || echo "dist-stub: clean"
grep -ri "satellite\|has_satellite\|satUrlTemplate\|has_sat" frontend/src/pages/maps/ frontend/src/components/settings/Maps* && exit 1 || echo "satellite: clean"
```

Both greps must return zero hits.

## Commit message

```
feat(maps): frontend speaks local-build phases, satellite removed

Satellite-tab, satellite-warning banner, and every satellite-related
field/state in the Maps admin + the /maps renderer are gone —
backend dropped support in chunk 2. Chunk 5 re-introduces a 3D
buildings toggle in the same visual slot.

Per-region progress chip shows a human phase label ("Downloading
OSM data", "Building vector tiles", …) plus a time estimate for the
long tippecanoe / valhalla stages, derived from the per-region PBF
size and platform.

NoRegionsEmptyState on /maps loses the self-hoster copy from 8a and
gains a one-liner explaining what the first install actually does.
The LOKIDOKI_MAPS_DIST_BASE / stub-banner pipe from 8a is fully
unwound front-to-back.

Refs docs/roadmap/maps-local-build/PLAN.md chunk 4.
```

## Deferrals section (append as you discover)

- **Re-introducing satellite if USGS NAIP lands** — would require
  bringing back a single satellite artifact type + one checkbox +
  one layer mode. Keep the diff from this chunk small so that
  reversing it (if needed) is an easy future rebase.
