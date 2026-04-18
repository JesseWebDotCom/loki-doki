# Chunk 2 — Map region catalog + admin panel + download pipeline

## Goal

Ship the catalog + region-picker UI + multi-file download pipeline so a user can select "Connecticut streets + satellite, California streets only" from the admin panel, watch one combined progress bar, and end up with the correct artifacts on disk under `data/maps/<region>/`. No routing or geocoding wiring yet — just "the files are present." After this chunk, `/api/v1/maps/regions` returns the installed regions with their artifact inventory; Chunks 3/5/6 consume it.

## Files

- `lokidoki/maps/__init__.py` — new subsystem package.
- `lokidoki/maps/catalog.py` — `MapRegion` dataclass (14 fields incl. `street_url_template`, `satellite_url_template`, `pbf_url_template` for Geofabrik), module-level `MAP_CATALOG` tree-structured by `parent_id`.
- `lokidoki/maps/models.py` — `MapArchiveConfig` (user selection), `MapRegionState` (per-region install state: `street_installed`, `satellite_installed`, `bytes_on_disk`), `MapInstallProgress` (SSE event shape).
- `lokidoki/maps/store.py` — read/write `data/maps_config.json` and `data/maps_state.json`; `install_region()` coroutine that downloads, verifies sha256, and atomically renames into `data/maps/<region>/`.
- `lokidoki/maps/seed.py` — seed `MAP_CATALOG` entries (see §Seed catalog below).
- `lokidoki/api/routes/maps.py` — extend the stub router from Chunk 1:
  - `GET /catalog` (tree) · `GET /catalog/flat`
  - `GET /regions` (installed, overrides the stub)
  - `PUT /regions/{region_id}` (install/update selection) · `DELETE /regions/{region_id}`
  - `GET /regions/{region_id}/progress` (SSE stream for an in-flight install)
  - `GET /storage` (aggregate usage)
- `frontend/src/components/settings/MapsSection.tsx` — new: the tabbed region picker (Street / Satellite), tree with checkboxes, running total pill, preset buttons, install/cancel button.
- `frontend/src/components/settings/MapsSection.helpers.ts` — tree flatten/aggregate-size utilities, unit-testable.
- `frontend/src/components/ui/ConfirmDialog.tsx` — existing, reused for "Replace current selection?" modals. No edit.
- `tests/unit/test_maps_catalog.py` — new.
- `tests/unit/test_maps_store.py` — new.
- `tests/unit/test_maps_api_regions.py` — supersedes the stub test from Chunk 1.
- `frontend/src/components/settings/MapsSection.helpers.test.ts` — new, runs under vitest.

Read-only: `lokidoki/archives/store.py` (mirror download + atomic-rename pattern), `lokidoki/archives/models.py`, `frontend/src/components/settings/ArchivesSection.tsx`.

## Actions

### Backend

1. **`MapRegion` dataclass** in `lokidoki/maps/catalog.py`:
   ```python
   @dataclass(frozen=True)
   class MapRegion:
       region_id: str           # "us", "us-ca", "us-ct", "ca", "uk"
       label: str
       parent_id: str | None
       center_lat: float
       center_lon: float
       bbox: tuple[float, float, float, float]   # (minLon, minLat, maxLon, maxLat)
       # Streets + satellite — always distributed as artifacts
       street_size_mb: float
       satellite_size_mb: float
       street_url_template: str
       satellite_url_template: str
       street_sha256: str
       satellite_sha256: str | None
       # Routing — prebuilt tiles always available; .pbf only needed when local build is allowed
       valhalla_size_mb: float
       valhalla_url_template: str      # prebuilt .tar.zst — primary install path
       valhalla_sha256: str
       pbf_size_mb: float              # Geofabrik .osm.pbf — needed for FTS (Ch5) + optional local Valhalla build (Ch6)
       pbf_url_template: str
       pbf_sha256: str
       pi_local_build_ok: bool         # catalog-authored: True iff region is small enough to build on 8 GB Pi
   ```
   **`pi_local_build_ok` rule**: `True` when `pbf_size_mb < 500` (roughly state-scale), else `False`. Country-scale regions set this to `False`; Chunk 6 refuses local builds for them regardless of the `allow_local_build` user flag and always pulls the prebuilt `.tar.zst`.
2. **`MAP_CATALOG`** in `lokidoki/maps/seed.py` — populate at least these regions for v1 (sizes from PLAN global context):
   - Continents: `na`, `eu`, `as` (parent-only, no downloads)
   - Countries: `us` (contig), `ca`, `mx`, `uk`, `de`, `fr`, `it`, `jp`
   - US states: all 50 (use a programmatic loop fed by a hand-audited size table — do not individually type 50 objects). Sizes can be linearly derived from the state's land area + 1.0× constant; the exact bytes are checked post-download.
3. **`install_region()`** in `lokidoki/maps/store.py`:
   - Resolves target URLs from the catalog entry, downloads each to `data/maps/<region>/.tmp/<artifact>`, verifies sha256, `os.replace()` into the final path. Partial `.tmp/` dirs are cleaned on next boot.
   - **Always downloads the prebuilt Valhalla `.tar.zst`** (`valhalla_url_template`) alongside `streets.pmtiles`. Extracted to `data/maps/<region>/valhalla/` via atomic swap. This makes Chunk 6's install step a no-op for the common path — Valhalla only has to spin up against an already-complete tile dir.
   - **`.pbf` is only downloaded when needed**: Chunk 5 always needs it (FTS build); Chunk 6 needs it only if the user has enabled `allow_local_valhalla_build` AND `region.pi_local_build_ok`. After all build steps that need the `.pbf` finish, it's deleted (default) to reclaim disk.
   - Emits `MapInstallProgress(region_id, artifact, bytes_done, bytes_total, phase)` via an `asyncio.Queue` the SSE endpoint drains. `artifact` values: `"street" | "satellite" | "pbf" | "valhalla" | "geocoder"`.
   - Supports cancellation via an `asyncio.Event`; on cancel, deletes the `.tmp/` dir (partial files only — never touches installed artifacts).
4. **Routes** in `lokidoki/api/routes/maps.py`:
   - Preserve the Chunk 1 stub's shape: `/regions` now reads from `MapRegionState` store.
   - `PUT /regions/{region_id}` body: `{"street": bool, "satellite": bool}`. Enforces satellite-requires-street — return `409` with `{"error": "satellite_requires_street"}`.
   - `GET /storage`: sum `bytes_on_disk` across all installed regions, split by artifact type (`street`, `satellite`, `pbf` — the latter kept only if Chunk 6 has run; otherwise reports 0).

### Frontend

5. **`MapsSection.tsx`** — follow `ArchivesSection.tsx`'s card pattern at the outer layer, but inside the card body render a tabbed view (two tabs: **Street maps**, **Satellite imagery**). Each tab body:
   - Tree view of regions (parent → children), CSS-driven indentation. Leaf rows have a checkbox; parents show aggregate size and a "select all children" helper.
   - Running total pill at the bottom: `Street: 480 MB · Satellite: 8 GB · Total: 8.5 GB` — updates live as checkboxes toggle.
   - Preset buttons above the tree: **My region**, **My country**, **North America**, **Clear all**. "My region" and "My country" call `navigator.geolocation.getCurrentPosition` (prompted — graceful permission-denied path), reverse-geocode via the existing Nominatim path if online (this pane is an admin setup step; online-assist is fine), otherwise fall back to a country dropdown.
   - The satellite tab greys out rows whose street region is not selected. A bold warning banner at the top: *"Satellite imagery is 10–20× larger than street maps. Pick only the regions you actually need photography for."*
6. **Install button** opens `ConfirmDialog` with the combined size. On confirm, `PUT /regions/{r}` for each changed region, then opens the SSE stream from `/regions/{r}/progress` and drives a single horizontal progress bar (files complete / total files, bytes done / total bytes). Cancel button sends `DELETE /regions/{r}` which also cancels an in-flight install.
7. **`MapsSection.helpers.ts`** — pure TS helpers: `flattenTree`, `aggregateSize`, `validateSelection` (enforces satellite-requires-street). Vitest tests in `.test.ts`.

### Tests

8. `tests/unit/test_maps_catalog.py`:
   - `test_catalog_has_at_least_50_us_states`
   - `test_every_region_has_valid_url_templates` (regex-checked)
   - `test_parent_ids_resolve` (no dangling parent refs)
   - `test_bbox_sanity` (min < max)
9. `tests/unit/test_maps_store.py` (monkeypatch download with a local file server):
   - `test_install_region_creates_expected_files`
   - `test_install_region_sha256_mismatch_deletes_tmp`
   - `test_install_region_cancellation_cleans_tmp`
   - `test_satellite_requires_street_enforced`
10. `tests/unit/test_maps_api_regions.py`:
    - `test_put_region_conflicts_when_satellite_without_street`
    - `test_delete_region_cleans_disk`
    - `test_storage_aggregates_by_artifact_type`
11. `frontend/src/components/settings/MapsSection.helpers.test.ts`:
    - `aggregateSize with nested selections`
    - `validateSelection rejects satellite-only`
    - `flattenTree depth-first order`

## Verify

```bash
uv run pytest tests/unit/test_maps_catalog.py tests/unit/test_maps_store.py tests/unit/test_maps_api_regions.py -x && \
cd frontend && pnpm test -- MapsSection.helpers && pnpm tsc --noEmit && pnpm build && cd .. && \
uv run python -c "
from lokidoki.maps.catalog import MAP_CATALOG
states = [r for r in MAP_CATALOG.values() if r.parent_id == 'us']
assert len(states) >= 50, f'only {len(states)} US states in catalog'
print('catalog OK —', len(MAP_CATALOG), 'regions')
"
```

Manual smoke: `./run.sh`, open Settings → Knowledge Archives → Maps. Select "Connecticut" on both tabs, click Install. Watch the progress bar run. Confirm `data/maps/us-ct/streets.pmtiles` and `data/maps/us-ct/satellite/` exist and pass sha256.

## Commit message

```
feat(maps): region catalog + admin picker + download pipeline

Adds lokidoki/maps/ subsystem — MAP_CATALOG with ~70 seed regions
(continents, 10 countries, 50 US states), MapArchiveConfig /
MapRegionState persisted at data/maps_config.json + data/maps_state.json,
and install_region() that downloads streets.pmtiles + satellite bundle +
.osm.pbf into data/maps/<region>/ with sha256 verification and
atomic rename.

Settings → Knowledge Archives → Maps surfaces the Apple Maps-style
region picker: tabbed Street / Satellite, tree-checkbox selection,
live running-total pill, three presets (My region / My country /
North America), and ConfirmDialog-driven install with SSE progress.
Satellite requires street; enforced at API and UI. No
window.confirm — uses shared ConfirmDialog per AGENTS.md:144.

Refs docs/roadmap/offline-maps/PLAN.md chunk 2.
```

## Deferrals section (append as you discover)

*(empty)*
