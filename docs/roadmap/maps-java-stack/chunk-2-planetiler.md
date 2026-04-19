# Chunk 2 — planetiler preflight + replace tippecanoe in install flow

## Goal

After this chunk, the region-install pipeline uses planetiler (not
tippecanoe) to produce `streets.pmtiles`. A new `install-planetiler`
preflight downloads the pinned `planetiler-dist.jar` from planetiler's
own GitHub Release to `data/tools/planetiler/planetiler.jar`. The
`build.run_tippecanoe` wrapper is replaced by `build.run_planetiler`,
which invokes `java -jar planetiler.jar`. Output path, progress
streaming, cancellation, and OOM classification all preserved.

Prereqs: chunk 1 (Temurin JRE on PATH) must be done.

## Files

- `lokidoki/bootstrap/versions.py` — add `PLANETILER` spec. Single
  JAR, so the per-(os, arch) matrix collapses to one entry (JARs are
  architecture-independent):
  ```python
  PLANETILER = {
      "version": "0.8.4",
      "filename": "planetiler.jar",
      "sha256": "<sha256>",
      "url_template": (
          "https://github.com/onthegomap/planetiler/releases/download/"
          "v{version}/planetiler.jar"
      ),
  }
  ```
- `lokidoki/bootstrap/preflight/planetiler.py` — new. Downloads the
  JAR to `data/tools/planetiler/planetiler.jar`, verifies sha256, runs
  `java -jar <jar> --help` as smoke test. No PATH patching needed —
  the JAR is invoked by absolute path from `build.run_planetiler`.
- `lokidoki/bootstrap/context.py` — add `"planetiler_jar"` to
  `_LAYOUT` as `{"unix": "planetiler/planetiler.jar", "win": "planetiler/planetiler.jar"}`
  so callers resolve it via `ctx.binary_path("planetiler_jar")`.
- `lokidoki/bootstrap/steps.py` — add `install-planetiler` spec
  and runner. Gate under `_PRE_MAPS_TOOLS` (reusing the list name
  that chunk 1 repurposed). `build_maps_tools_only_steps()` extends
  to `[detect-profile, install-jre, install-planetiler]`. Profile
  enablement stays off until chunk 4.
- `lokidoki/maps/build.py` — replace `run_tippecanoe` with
  `run_planetiler`. Same signature: `async def run_planetiler(pbf: Path, out_pmtiles: Path, *, region_id: str, emit, cancel_event) -> None`.
  Invocation:
  `java -Xmx<heap> -jar <planetiler.jar> --osm-path=<pbf> --output=<out_pmtiles> --force`
  with `<heap>` chosen from profile (2 GB on Pi, 4–8 GB on mac).
  Parse planetiler's progress log (`[layer_stats] … progress=NN%`
  lines — verify the exact format on first run and update this
  chunk's deferral section if the marker differs) into the existing
  `MapInstallProgress` event. Preserve `building`, `height`,
  `min_height`, `building:levels` OSM attributes in the output
  (planetiler's default `openmaptiles` profile already does — confirm
  by grepping the produced pmtiles for a `building` feature).
- `lokidoki/maps/store.py` — rename the phase-handler call from
  `build.run_tippecanoe(...)` to `build.run_planetiler(...)`. The
  `building_streets` phase string is unchanged. Error codes
  (`toolchain_missing`, `out_of_memory`, generic) stay the same.
- `tests/unit/test_maps_build.py` — rename
  `test_run_tippecanoe_*` tests to `test_run_planetiler_*`. Fake
  command: `java -jar <fake>.jar` — since the test already uses a
  `sh -c` stub for the subprocess, replace with an equivalent stub
  that emits a planetiler-shaped progress line.
- `tests/unit/test_maps_store.py` — update the `install_region`
  happy-path test's mocked symbol from `build.run_tippecanoe` to
  `build.run_planetiler`. No other test changes.
- `tests/unit/bootstrap/test_preflight_planetiler.py` — new. Mocked
  download + sha + `java -jar … --help` smoke test.
- `tests/unit/bootstrap/test_versions.py` — add `PLANETILER`
  assertions (single filename, URL shape).
- `lokidoki/maps/seed.py` — nothing to touch (the per-region
  catalogue already points at Geofabrik).

Read-only for reference:
[maps-local-build chunk-3-install-local.md](../maps-local-build/chunk-3-install-local.md)
(the original tippecanoe phase semantics we're preserving).

## Actions

1. Pull the pinned `planetiler.jar` once locally, record its sha256,
   paste into `versions.py`.
2. Write the preflight following the shape of
   [preflight/piper_runtime.py](../../../lokidoki/bootstrap/preflight/piper_runtime.py)
   (single-file download, sha verify, smoke test). No tar extraction.
3. Update `build.py::run_planetiler`:
   - Command: `[ctx.binary_path("java"), f"-Xmx{heap_mb}m", "-jar",
     str(ctx.binary_path("planetiler_jar")), f"--osm-path={pbf}",
     f"--output={out_pmtiles}", "--force"]`. Pick heap size per
     profile: `pi_cpu` → 2048, `mac` → 6144, `linux`/`windows` →
     4096. Expose as a module-level dict so chunk 3 / chunk 4 can
     reuse for GraphHopper.
   - Parse progress: planetiler logs one line per macro-phase plus a
     terminal `…finished in Xs` line. Map phase names
     (`osm_pass1`, `osm_pass2`, `archive`) to percent bands
     (0–30 %, 30–70 %, 70–100 %) so the UI ring advances smoothly.
     Exact log line format — verify on first live run and record in
     `## Deferrals` if drift shows up.
   - Cancellation: existing `cancel_event` path works as-is (SIGTERM
     propagates to the JVM, which shuts down cleanly).
   - OOM: JVM OOM exits with code 1 and a stderr line starting
     `Exception in thread "main" java.lang.OutOfMemoryError`.
     Classify on that substring, not exit code.
4. Update `store.py` call site. Keep the phase string `building_streets`.
5. Tests: update the stub command + progress parser expectations.
   Both `test_maps_build.py` and `test_maps_store.py` already use
   `sh -c`-based fakes — swap the emitted lines for planetiler
   shapes.
6. `build_maps_tools_only_steps()` → `[detect-profile, install-jre,
   install-planetiler]`. Leave `build_steps()` alone.

## Verify

```bash
uv run pytest tests/unit/bootstrap/test_preflight_planetiler.py \
              tests/unit/bootstrap/test_versions.py \
              tests/unit/test_maps_build.py \
              tests/unit/test_maps_store.py -x -q

# Live build (mac only, ~1 min for CT)
./run.sh --maps-tools-only
.lokidoki/tools/jre/bin/java -jar \
  .lokidoki/tools/planetiler/planetiler.jar --help | head -5
```

For a true end-to-end, install CT via the Maps admin tab and confirm
`data/maps/ct/streets.pmtiles` is produced. Defer that to chunk 4.

## Commit message

```
feat(maps): replace tippecanoe with planetiler

New install-planetiler preflight pulls planetiler.jar from
onthegomap/planetiler's own GitHub Release and lands it at
data/tools/planetiler/planetiler.jar. build.run_planetiler shells
to java -jar with a profile-sized heap, parses planetiler's phase
markers into the existing SSE progress stream, and preserves the
OSM building attributes the 3D buildings layer consumes.

--maps-tools-only now runs JRE + planetiler; profile enablement
stays off until chunk 4.

Refs docs/roadmap/maps-java-stack/PLAN.md chunk 2.
```

## Deferrals section (append as you discover)

*(empty — leave for chunk-2 execution to fill)*
