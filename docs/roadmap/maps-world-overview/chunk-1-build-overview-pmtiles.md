# Chunk 1 — Bootstrap: build `world-overview.pmtiles`

## Goal

After this chunk, running `./run.sh --maps-tools-only` (or a regular
bootstrap) produces
`.lokidoki/tools/planetiler/world-overview.pmtiles` — a single global
low-zoom pmtiles covering z0–z7 with Natural Earth data. The build
uses **the existing** `planetiler.jar` + pinned Natural Earth SQLite
+ pinned OSM water polygons + a new pinned **Monaco** PBF as a
throwaway tiny OSM input. No new tool is added to the bootstrap; a
new pin + a new preflight module are.

The file is referenced by chunk 2 (tile route) and chunk 3 (style
wiring) — nothing else knows about it yet.

## Files

- `lokidoki/bootstrap/versions.py` — add one pin:
  ```python
  # Geofabrik's Monaco extract. Used ONLY as a throwaway tiny OSM
  # input for the world-overview build — planetiler requires some
  # OSM file even when we only care about its Natural Earth output.
  # ~800 KB; occupies z0–z7 tiles on the Mediterranean coast. Mutable
  # URL, sha pinned hard; refresh deliberately.
  MONACO_PBF = {
      "version": "latest",
      "filename": "monaco-latest.osm.pbf",
      "sha256": "<capture fresh>",
      "url_template": (
          "https://download.geofabrik.de/europe/{filename}"
      ),
  }
  ```
- `lokidoki/bootstrap/preflight/world_overview.py` — new module. Shape:
  1. Short-circuit if
     `ctx.binary_path("world_overview_pmtiles")` exists and is
     > 1 MB (smoke test, not full verification — any corrupt file
     will be caught by the pmtiles reader at runtime).
  2. Require `java`, `planetiler_jar`, `planetiler_sources`
     (already present thanks to prior preflights) — raise if any
     is missing with a message pointing at `--maps-tools-only`.
  3. Download `monaco-latest.osm.pbf` into
     `.lokidoki/tools/planetiler/sources/` using `ctx.download`
     with the pinned sha256 from `versions.py`.
  4. Run planetiler with the SAME flag shape `run_planetiler` uses
     in [lokidoki/maps/build.py](../../../lokidoki/maps/build.py)
     (explicit per-file source paths, no `--download`), plus
     `--maxzoom=7`, writing to `world-overview.pmtiles`:
     ```
     java -Xmx<heap>m -jar planetiler.jar
       --osm-path=<sources>/monaco-latest.osm.pbf
       --natural_earth_path=<sources>/natural_earth_vector.sqlite.zip
       --water_polygons_path=<sources>/water-polygons-split-3857.zip
       --output=<...>/world-overview.pmtiles
       --maxzoom=7
       --force
     ```
  5. Use `ctx.run_streamed(...)` so output flows through the SSE
     channel, same as long-running preflights. Heap: start with
     2048 MB — the build is cheap but NE+water polygons need the
     room.
  6. Smoke test post-build: file exists and size > 5 MB. If file is
     suspiciously small, delete and raise (corrupt build).
  7. Emit a final `StepLog` recording path + size.
- `lokidoki/bootstrap/context.py` — add `"world_overview_pmtiles"`
  to `_LAYOUT`, pointing at
  `tools/planetiler/world-overview.pmtiles` on both unix and win.
- `lokidoki/bootstrap/preflight/__init__.py` — re-export
  `ensure_world_overview`.
- `lokidoki/bootstrap/steps.py`:
  - Import `ensure_world_overview` from `.preflight`.
  - Register `"build-world-overview"` in `_REAL_RUNNERS`.
  - Register `"build-world-overview"` → `"system"` in
    `_STEP_CATEGORY`.
  - Append `("build-world-overview", "Build world overview basemap",
    False, 120)` to `_PRE_MAPS_STACK` **after** `install-planetiler-data`
    (it depends on planetiler jar, JRE, and sources being present).
- `scripts/build_offline_bundle.py` — add `MONACO_PBF` to the maps
  block alongside NE + water polygons. **Do not** bundle the built
  `world-overview.pmtiles` itself — the offline bundle carries
  *inputs*, not derived artifacts; bootstrap re-runs the build on
  the target machine.
- `tests/unit/bootstrap/test_versions.py` — add shape assertions for
  `MONACO_PBF` (64-char sha hex, https URL, filename ends
  `.osm.pbf`).
- `tests/unit/bootstrap/test_preflight_world_overview.py` — new.
  Mock `ctx.download` and `ctx.run_streamed`. Assertions:
  - Pinned sha256 is passed to `download` for monaco.
  - planetiler command contains `--maxzoom=7`, the three explicit
    source paths, and `--output=<...>/world-overview.pmtiles`.
  - Command does NOT contain `--download` (substring check — same
    audit as the chunk-2 offline-hardening test).
  - Skip path fires when target file already exists and is > 1 MB.
  - Smoke-fail path: when post-build file is < 5 MB, preflight
    raises and removes the partial.

Read-only for reference:
- [lokidoki/bootstrap/preflight/planetiler_data.py](../../../lokidoki/bootstrap/preflight/planetiler_data.py)
  — download-only preflight pattern (size check, sha verify).
- [lokidoki/bootstrap/preflight/planetiler.py](../../../lokidoki/bootstrap/preflight/planetiler.py)
  — planetiler jar install + java smoke-test pattern.
- [lokidoki/maps/build.py::run_planetiler](../../../lokidoki/maps/build.py)
  — authoritative CLI shape to mirror. Mirror flags exactly, do not
  invent new flag names.

## Actions

1. Capture fresh sha256 for `monaco-latest.osm.pbf` from Geofabrik.
   Paste hex into `MONACO_PBF["sha256"]`.
2. Add the `MONACO_PBF` pin in `versions.py`.
3. Add `"world_overview_pmtiles"` to `_LAYOUT` in `context.py`.
4. Write `preflight/world_overview.py` per the shape above. Re-use
   `ctx.download` for monaco, `ctx.run_streamed` for planetiler.
5. Export `ensure_world_overview` from `preflight/__init__.py`.
6. Wire the new step in `steps.py` (`_REAL_RUNNERS` + `_STEP_CATEGORY`
   + `_PRE_MAPS_STACK`).
7. Extend `scripts/build_offline_bundle.py` maps block to include
   monaco.
8. Add `test_versions.py` shape test.
9. Add `test_preflight_world_overview.py` with four cases: happy
   path, skip-when-present, tiny-output-fails, command-shape.
10. Do not run `build-world-overview` end-to-end in tests — it's
    a 30-second planetiler run. Verification in unit tests stays at
    command-shape level.

## Verify

```bash
uv run pytest tests/unit/bootstrap/test_preflight_world_overview.py \
              tests/unit/bootstrap/test_versions.py -x -q

# Grep audit: the new preflight MUST NOT carry --download substring
# (including --download_dir / --downloads) — same rule as the
# offline-hardening chunk 2 planetiler invocation.
rg -- "--download" lokidoki/bootstrap/preflight/world_overview.py \
  && echo "VIOLATION" || echo "OK"

# Optional live smoke (uncomment when you actually want to exercise
# the real planetiler build — takes ~30 s on Apple Silicon):
# rm -f .lokidoki/tools/planetiler/world-overview.pmtiles
# ./run.sh --maps-tools-only
# ls -la .lokidoki/tools/planetiler/world-overview.pmtiles
# # expect ≥ 5 MB
```

## Commit message

```
feat(maps): build world-overview.pmtiles in bootstrap

New `build-world-overview` preflight runs planetiler against the
pinned Natural Earth data plus a tiny Monaco OSM extract, producing
`.lokidoki/tools/planetiler/world-overview.pmtiles` — a ~20–50 MB
global z0–z7 basemap. Output feeds a dual-source MapLibre style
(chunks 2 + 3) so country/state labels and ocean fill render even
outside installed regions, closing the "blank on zoom-out" bug.

Monaco is a throwaway tiny OSM input; planetiler's OpenMapTiles
profile emits Natural Earth features globally at low zoom regardless
of OSM extent. Alternative (custom NE-only planetiler profile) would
require shipping a compiled Java plugin — rejected.

Refs docs/roadmap/maps-world-overview/PLAN.md chunk 1.
```

## Deferrals section (append as you discover)

*(empty — leave for chunk-1 execution to fill)*
