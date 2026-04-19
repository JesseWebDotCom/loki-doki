# Chunk 3 — Rewrite `install_region` to build locally

## Goal

After this chunk, clicking Install for a region on the Maps admin tab
does the full job: downloads the PBF from Geofabrik, builds the FTS5
geocoder, runs `tippecanoe` to produce `streets.pmtiles`, runs
`valhalla_build_tiles` to produce the routing tile tree, and cleans
up the PBF. Every stage streams progress over the existing SSE route
so the admin UI never sits at a silent spinner. Every stage is
cancellable mid-run. Partial state on crash / cancel is cleaned up
from the `.tmp/` dir — no corrupt install leaks onto disk.

Prereqs: chunk 1 (binaries on PATH) and chunk 2 (slim MapRegion)
must be done.

## Files

- `lokidoki/maps/build.py` — new. Async subprocess wrappers for `tippecanoe` and `valhalla_build_tiles`. Each streams stdout/stderr, reports byte/step progress, and handles cancellation by SIGTERM-ing the process.
- `lokidoki/maps/store.py` — rewrite `install_region`. New phase order: `downloading_pbf` → `building_geocoder` → `building_streets` → `building_routing` → `complete`. Existing PBF download helper stays. Existing geocoder build call stays (just moves earlier).
- `lokidoki/maps/models.py` — add any new phase string constants if the codebase uses enums / literal types; otherwise unchanged.
- `tests/unit/test_maps_store.py` — extend with `async def test_install_region_runs_local_build` that mocks `build.run_tippecanoe` + `build.run_valhalla` and asserts the four phase events emit.
- `tests/unit/test_maps_build.py` — new. Tests the subprocess wrappers against a fake command (e.g., `sh -c 'echo progress; sleep 0.05; echo done'`) to exercise the progress-parsing + cancellation paths without needing real tippecanoe.

Read-only: [lokidoki/maps/geocode/fts_build.py](../../../lokidoki/maps/geocode/fts_build.py) (already-working PBF → SQLite FTS build — still called from here).

## Actions

1. `build.py`:
   - `async def run_tippecanoe(pbf: Path, out_pmtiles: Path, *, region_id: str, emit, cancel_event) -> None` — builds with `-z14 --drop-densest-as-needed --force -y height -y min_height -y building:levels -y building`. The `-y` flags preserve OSM building attributes so chunk 5's 3D buildings layer can render heights — without them tippecanoe drops unknown tags and every building renders flat. Streams stdout; tippecanoe prints `% complete` markers suitable for rough progress.
   - `async def run_valhalla(pbf: Path, out_dir: Path, *, region_id: str, emit, cancel_event) -> None` — builds a minimal `valhalla.json` on the fly (reuse the one [lokidoki/maps/routing/build_tiles.py](../../../lokidoki/maps/routing/build_tiles.py) already ships, if present), runs `valhalla_build_tiles -c <json> <pbf>`, reports phase-by-phase (valhalla logs discrete stages).
   - Both wrappers refuse to run if the binary is missing from PATH — surface a message pointing at `./run.sh --maps-tools-only` from chunk 1.
2. `store.py::install_region`:
   - Order: `downloading_pbf` → `building_geocoder` (fastest, unblocks search quickly) → `building_streets` → `building_routing`.
   - Every successful stage flips the matching `state.<artifact>_installed = True` and records `bytes_on_disk[artifact]`.
   - On any failure, clean `.tmp/` and emit `complete` with `error=<str(exc)>`.
   - PBF deletion still happens unless `_keep_pbf()` says otherwise (existing toggle).
3. Cancel path:
   - `cancel_event.is_set()` checked between stages and forwarded into `run_tippecanoe` / `run_valhalla` so the subprocess gets SIGTERM'd.
   - On cancel, partial outputs (half-written .pmtiles, half-built valhalla tile dir) are deleted; nothing leaks to the final `data/maps/<region>/`.
4. Progress estimates:
   - `bytes_total` for `downloading_pbf` = `region.pbf_size_mb * 1024 * 1024` (existing hint).
   - For build phases, use step-based progress (`bytes_done` / `bytes_total` repurposed as `step_done` / `step_total`) so the UI's existing percentage rendering still works. Document the repurpose in a comment.
5. Error classification:
   - Binary missing → `error="toolchain_missing"` (UI shows "Re-run bootstrap — tippecanoe not on PATH").
   - Build OOM (exit code 137 / killed by OOM killer) → `error="out_of_memory"` (UI shows "Region too large for this device's RAM").
   - Any other non-zero exit → `error="<tool> failed: <last-stderr-line>"`.

## Verify

```bash
pytest tests/unit/test_maps_store.py tests/unit/test_maps_build.py \
       tests/unit/test_maps_api_regions.py -x

# Smoke: with the real binaries on PATH, install CT and assert files
# end up on disk. Skipped in CI; run locally before flipping the row.
LOKIDOKI_MAPS_SMOKE=1 pytest tests/integration/test_maps_ct_install.py -x
```

If the integration test doesn't exist yet, skip the smoke — unit
tests suffice for the verify pass. Note the skip in the commit body.

## Commit message

```
feat(maps): install_region now builds PMTiles and Valhalla tiles locally

Region install flow is: download Geofabrik PBF, build FTS5 geocoder
(fast, so search works while the big builds run), run tippecanoe
for streets.pmtiles, run valhalla_build_tiles for the routing tile
tree. Each phase streams progress over the existing SSE route and
is cancellable mid-build; partial outputs never leak into
data/maps/<region>/ on failure.

build.py wraps the two subprocesses, parses their progress markers,
and surfaces toolchain-missing / OOM / generic errors with distinct
error codes for the admin UI.

Refs docs/roadmap/maps-local-build/PLAN.md chunk 3.
```

## Deferrals section (append as you discover)

- **Parallel tippecanoe + valhalla** — both builds are CPU-heavy; on
  a beefy host they could run in parallel. Not for Pi (2 GB each
  stacks over the RAM budget). Follow-up chunk if metric-driven.
- **Resumable builds** — cancelling mid-tippecanoe throws away
  progress. Not worth the complexity for single-region installs;
  revisit if users report it.
