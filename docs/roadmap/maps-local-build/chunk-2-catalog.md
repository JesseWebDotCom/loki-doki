# Chunk 2 — Slim the maps catalog, drop CDN + satellite plumbing

## Goal

Delete everything in the maps subsystem that assumed either a remote
CDN for pre-built artifacts or an offline-satellite feature. After
this lands, the backend knows about exactly one download per region
(the Geofabrik PBF); everything else is derived from it locally in
chunk 3.

This chunk is pure deletion + field removal. No build logic lands
yet. After it merges:
- `grep -r "dist.lokidoki.app" lokidoki/` returns zero hits.
- `grep -r "LOKIDOKI_MAPS_DIST_BASE" lokidoki/` returns zero hits.
- `grep -ri "satellite" lokidoki/maps/ lokidoki/api/routes/maps.py`
  returns zero hits.

## Files

- `lokidoki/maps/catalog.py` — shrink `MapRegion`; delete `dist_base`, `is_stub_dist`, `DIST_BASE_ENV`, `DEFAULT_DIST_BASE`.
- `lokidoki/maps/seed.py` — drop the `dist` local + stop populating removed fields; stop emitting satellite size estimates.
- `lokidoki/maps/models.py` — remove `satellite_installed` from `MapRegionState`; remove `satellite` from `MapArchiveConfig`; drop `"satellite"` from any artifact phase enums.
- `lokidoki/maps/store.py` — collapse `_artifact_plan` to the single PBF entry; delete the satellite branch of `install_region`; drop `satellite` from `aggregate_storage`.
- `lokidoki/api/routes/maps.py` — delete `get_satellite_tile` + `_ALLOWED_SAT_EXTS`; remove `satellite` from `RegionSelection` / the 409 `satellite_requires_street` check; remove the `dist_base` / `is_stub_dist` keys from `get_storage`.
- `tests/unit/test_maps_catalog.py` — delete the three `dist_base_*` tests from sub-chunk 8a; adjust URL-template assertions (only `pbf_url_template` remains for downloadable rows).
- `tests/unit/test_maps_store.py` — update plan + install assertions; drop satellite-path tests.
- `tests/unit/test_maps_api_regions.py` — drop satellite 409 test; drop satellite state assertions.
- `tests/unit/test_maps_tile_route.py` — delete the satellite-tile tests (the route is gone).

Read-only for reference: [offline-maps/chunk-8-deferrals-rollup.md](../offline-maps/chunk-8-deferrals-rollup.md) — sub-chunk 8a is what this chunk unwinds.

## Actions

1. In `catalog.py`, remove fields from `MapRegion`:
   - `street_url_template`, `street_sha256`
   - `satellite_size_mb`, `satellite_url_template`, `satellite_sha256`
   - `valhalla_url_template`, `valhalla_sha256`
   Keep `pbf_url_template`, `pbf_sha256`, `street_size_mb`,
   `valhalla_size_mb`, `pbf_size_mb`, bbox, labels, `pi_local_build_ok`.
2. Update `is_parent_only` — the easy check becomes `pbf_url_template == ""`.
3. Delete `DIST_BASE_ENV`, `DEFAULT_DIST_BASE`, `dist_base()`, `is_stub_dist()`, and the `import os`.
4. `seed.py::build_catalog`:
   - Drop the `dist = dist_base()` local.
   - Stop passing `satellite_size_mb` / `satellite_url_template` /
     `satellite_sha256` / `street_url_template` / `street_sha256` /
     `valhalla_url_template` / `valhalla_sha256` — those kwargs are
     gone after step 1.
5. `models.py`:
   - `MapArchiveConfig` loses the `satellite: bool` field (becomes a
     single-flag config where `street` is the only toggle — or
     collapse the class entirely if it's trivial after).
   - `MapRegionState` loses `satellite_installed` + the `satellite`
     key from `bytes_on_disk` dict bookkeeping.
   - Any `Literal["street", "satellite", ...]` type alias loses the
     `"satellite"` member.
6. `store.py`:
   - `_artifact_plan` returns `[("pbf", ...)]` unconditionally for
     any selected config.
   - `install_region` drops the satellite download + extraction
     branch.
   - `aggregate_storage` drops `"satellite"` from its totals dict.
   - `delete_region_disk` no longer needs the `satellite/` subtree
     walk — but `rm -rf data/maps/<region>/` still works.
7. `api/routes/maps.py`:
   - Delete `get_satellite_tile` (both the route and the handler).
   - Delete `_ALLOWED_SAT_EXTS`.
   - `RegionSelection` loses `satellite: bool`.
   - Remove the `satellite_requires_street` 409 from `upsert_region`.
   - `get_storage` response drops `dist_base` + `is_stub_dist`.
8. Tests (all in `tests/unit/`):
   - `test_maps_catalog.py`: delete `test_dist_base_*` (3 tests);
     change `test_every_region_has_valid_url_templates` to only
     validate `pbf_url_template`.
   - `test_maps_store.py`: drop `test_install_region_satellite_*`
     tests; update plan-shape tests.
   - `test_maps_api_regions.py`: drop
     `test_satellite_without_street_conflicts`; adjust state
     assertions.
   - `test_maps_tile_route.py`: delete the satellite-tile tests.

## Verify

```bash
pytest tests/unit/test_maps_catalog.py tests/unit/test_maps_store.py \
       tests/unit/test_maps_api_regions.py tests/unit/test_maps_tile_route.py \
       tests/unit/test_maps_api_stub.py -x

grep -r "dist.lokidoki.app" lokidoki/ tests/ && exit 1 || echo "cdn: clean"
grep -r "LOKIDOKI_MAPS_DIST_BASE" lokidoki/ tests/ && exit 1 || echo "env: clean"
grep -ri "satellite" lokidoki/maps/ lokidoki/api/routes/maps.py tests/unit/test_maps_*.py \
  && exit 1 || echo "satellite: clean"
```

All four assertions must pass.

## Commit message

```
refactor(maps): drop CDN + satellite plumbing from the backend

MapRegion is down to one real download (Geofabrik PBF) and catalog
metadata (sizes, bbox). Everything that pretended a remote host
published PMTiles / satellite tarballs / Valhalla tarballs is
deleted:

- catalog.py: fields + DIST_BASE_ENV / dist_base() / is_stub_dist()
- seed.py: stops filling the removed fields
- models.py: MapArchiveConfig.satellite, MapRegionState.satellite_installed
- store.py: _artifact_plan collapses to pbf-only; satellite install
  branch + aggregate_storage's satellite key gone
- routes/maps.py: get_satellite_tile + _ALLOWED_SAT_EXTS deleted;
  RegionSelection.satellite + the satellite_requires_street 409 gone;
  /storage response no longer surfaces dist_base / is_stub_dist

The offline-maps plan's sub-chunk 8a (dist override + stub banner)
is unwound on the backend here; the frontend cleanup lands in
chunk 4. The 3D buildings layer (chunk 5) replaces the satellite
visual affordance.

Refs docs/roadmap/maps-local-build/PLAN.md chunk 2.
Supersedes docs/roadmap/offline-maps/chunk-8-deferrals-rollup.md
sub-chunk 8a.
```

## Deferrals section (append as you discover)

- **Re-adding satellite via USGS NAIP** — explicitly out of scope.
  Future chunk if demand materialises; data would live under
  `data/maps/<region>/naip/` with its own catalog toggle, parallel
  to but separate from the (now-removed) generic satellite slot.
