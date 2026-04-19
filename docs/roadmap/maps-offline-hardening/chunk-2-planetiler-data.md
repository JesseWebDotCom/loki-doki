# Chunk 2 — planetiler offline data sources + drop `--download`

## Goal

After this chunk, the `building_streets` phase of a region install
does not require network access. planetiler reads Natural Earth
polygons and OSM water polygons from pre-seeded files in
`data/tools/planetiler/sources/` instead of fetching them at build
time. The `--download` flag is removed from the command line;
planetiler runs fully air-gapped. A new `install-planetiler-data`
preflight pulls and caches the two upstream datasets during bootstrap.

Prereqs: chunk 1 done (not strictly required, but keeps the plan
sequential).

## Files

- `lokidoki/bootstrap/versions.py` — add two entries:
  ```python
  NATURAL_EARTH = {
      "version": "<upstream version>",
      "filename": "natural_earth_vector.sqlite.zip",
      "sha256": "<sha256>",
      "url_template": (
          "https://naciscdn.org/naturalearth/packages/"
          "natural_earth_vector.sqlite.zip"
      ),
  }
  OSM_WATER_POLYGONS = {
      "version": "<upstream date stamp>",
      "filename": "water-polygons-split-3857.zip",
      "sha256": "<sha256>",
      "url_template": (
          "https://osmdata.openstreetmap.de/download/"
          "water-polygons-split-3857.zip"
      ),
  }
  ```
  Both upstreams serve mutable URLs (no per-version GH release). Pin
  the sha256 hard and refresh only on deliberate update. If the
  remote sha drifts between chunk-2 authoring and execution, the
  preflight fails sha check — that's correct: stop and refresh the
  pin deliberately.
- `lokidoki/bootstrap/preflight/planetiler_data.py` — new. Downloads
  both archives, verifies sha, extracts each into
  `data/tools/planetiler/sources/` (planetiler expects
  `natural_earth_vector.sqlite` and `water-polygons-split-3857/`
  unpacked alongside each other). Smoke test: assert both paths
  exist and non-empty post-extract. Register `"planetiler_sources"`
  in `ctx.tools`.
- `lokidoki/bootstrap/context.py` — add `"planetiler_sources"` to
  `_LAYOUT` as a dir entry pointing at
  `tools/planetiler/sources`.
- `lokidoki/bootstrap/steps.py` — register `install-planetiler-data`
  in `_REAL_RUNNERS` / `_STEP_CATEGORY` (`"system"`). Add to
  `_PRE_MAPS_STACK` immediately after `install-planetiler` (data
  depends on the planetiler JAR being present only implicitly —
  keeping them adjacent makes the failure story obvious).
- `lokidoki/maps/build.py` — drop `--download` from the planetiler
  command. Add `--data-dir=<path>` pointing at the new
  `planetiler_sources` directory. planetiler recognizes the flag and
  reads the two archives from there. Example:
  ```python
  cmd = [
      java_bin, f"-Xmx{heap_mb}m", "-jar", str(jar_path),
      f"--osm-path={pbf}",
      f"--output={scratch}",
      f"--data-dir={ctx.binary_path('planetiler_sources')}",
      "--force",
  ]
  ```
  Confirm the exact flag name (`--data-dir` vs `--data_dir` vs
  `--tmpdir`) from `java -jar planetiler.jar --help` before writing
  the test; planetiler's CLI is Java-convention `--snake_case` in
  some spots. Record observed behaviour in
  `## Deferrals` if it differs.
- `scripts/build_offline_bundle.py` — add both archives to the
  manifest. Together they are ~1.2 GB, so call out the size in the
  bundle builder's log line.
- `tests/unit/bootstrap/test_preflight_planetiler_data.py` — new.
  Mock both downloads with small zip fixtures; assert the target
  directory layout; assert sha verification fires per file.
- `tests/unit/bootstrap/test_versions.py` — add assertions for both
  new entries.
- `tests/unit/test_maps_build.py` — update the
  `test_run_planetiler_*` stubs to assert `--data-dir=...` appears
  in the command and `--download` does not.

Read-only for reference:
[lokidoki/bootstrap/preflight/temurin_jre.py](../../../lokidoki/bootstrap/preflight/temurin_jre.py)
(tarball download + extract pattern),
[lokidoki/maps/build.py::run_planetiler](../../../lokidoki/maps/build.py)
(the command builder to edit).

## Actions

1. Verify the upstream URLs are still live; capture fresh sha256
   against the actual file contents.
2. Write `preflight/planetiler_data.py`. Both archives are big — the
   preflight should emit progress events through the existing
   bootstrap SSE channel (copy the pattern from
   `preflight/llama_cpp_runtime.py` which handles a big download).
3. Wire `install-planetiler-data` into the pipeline.
4. Edit `build.py::run_planetiler`:
   - Remove `--download`.
   - Add `--data-dir=<ctx.binary_path('planetiler_sources')>`.
   - Heap size logic unchanged.
5. Offline bundle script: add both entries.
6. Tests:
   - Preflight test with zip fixtures.
   - `test_versions.py` — shape assertions for both.
   - `test_maps_build.py` — CLI assertion changes.
7. Drop any stale TODO / offline-violation comments in
   `docs/maps-build.md` that still reference `--download`.

## Verify

```bash
uv run pytest tests/unit/bootstrap/test_preflight_planetiler_data.py \
              tests/unit/bootstrap/test_versions.py \
              tests/unit/test_maps_build.py -x -q

rm -rf .lokidoki/tools/planetiler/sources
./run.sh --maps-tools-only
ls data/tools/planetiler/sources
# Should include natural_earth_vector.sqlite and water-polygons-split-3857/

# End-to-end (mac only): uninstall CT, reinstall it with network
# disabled AFTER the preflight completes:
# 1. UI: Settings → Maps → uncheck CT → wait for delete
# 2. Disable Wi-Fi
# 3. UI: Settings → Maps → check CT → Install
# Expected: download_pbf FAILS (no network) — that's the Geofabrik
# step, separate concern. Re-enable Wi-Fi, pre-download the PBF via
# the existing Geofabrik step, disable Wi-Fi again, retry install.
# building_streets must succeed offline with the new --data-dir.

# Grep audit — MUST return zero --download references in the planetiler
# command after this chunk:
rg -- "--download" lokidoki/maps/build.py && echo "VIOLATION" || echo "OK"
```

## Commit message

```
feat(maps): pre-seed planetiler sources, drop --download

New install-planetiler-data preflight pulls Natural Earth + OSM water
polygons into data/tools/planetiler/sources/. run_planetiler now
passes --data-dir pointing at that dir and no longer uses --download,
so building_streets runs fully offline once the region PBF has landed.

Closes the second of two remaining runtime CDN holes flagged in the
offline-first invariant. The only remaining network touch in the
install pipeline is the pinned Geofabrik PBF download itself, which
already runs through the bootstrap-controlled HTTP path.

Refs docs/roadmap/maps-offline-hardening/PLAN.md chunk 2.
```

## Deferrals section (append as you discover)

- **planetiler CLI uses snake_case + explicit per-file paths, not
  `--data-dir`.** `java -jar planetiler.jar --help` on 0.8.4 lists
  `download_dir=data/sources`, `natural_earth_path=data/sources/
  natural_earth_vector.sqlite.zip`, and `water_polygons_path=
  data/sources/water-polygons-split-3857.zip`. `--data-dir` does not
  exist. The implementation uses the explicit
  `--natural_earth_path=<...>` + `--water_polygons_path=<...>` form
  rather than `--download_dir=<...>` so that:
  1. No "--download" substring appears in the command line (the grep
     audit in `## Verify` then matches cleanly).
  2. Intent is unambiguous — each source file is redirected at a
     specific local path; nothing hints at a remote fetch.
- **No extraction — planetiler reads the zips directly.** The plan
  described unpacking `water-polygons-split-3857.zip` into a directory,
  but planetiler's defaults point at the zip itself. The preflight keeps
  both archives zipped under `tools/planetiler/sources/`.
- **Archive sizes:** Natural Earth `sqlite.zip` is ~414 MiB (smaller
  than the plan's 400 MB estimate was rounded from); OSM water-polygons
  `.zip` is ~880 MiB. Combined ~1.3 GB mirrored into the offline bundle.
- **Pinned SHA-256** (captured against live upstream on 2026-04-19):
  - natural_earth_vector.sqlite.zip →
    `375da61836d4779dffa8b87887bc4faa94dac77745ba0ee3914bd7cbedf40a02`
  - water-polygons-split-3857.zip →
    `1711c438e8fefd9162e2aa9db566188445d72bfec25ac4cff9a1e23849df3382`
  Both upstreams serve mutable URLs; drift = pin refresh.
