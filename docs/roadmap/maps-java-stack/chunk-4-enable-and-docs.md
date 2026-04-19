# Chunk 4 — Re-enable maps profiles + end-to-end verify + docs update

## Goal

Maps becomes live on every supported profile. `_MAPS_ENABLED_PROFILES`
is re-populated so bootstrap auto-runs the JRE + planetiler +
GraphHopper preflights on every profile (including Windows, which
chunk 1 made first-class). A real CT install is performed end-to-end
on mac, verifying PBF download → FTS5 geocoder → planetiler streets →
GraphHopper routing → search + drop pin + get directions all work
without network after the initial install. Docs are updated; the
superseded `docs/roadmap/maps-local-build/` plan is flagged as
historical.

Prereqs: chunks 1, 2, 3 all `done`.

## Files

- `lokidoki/bootstrap/steps.py` — flip `_MAPS_ENABLED_PROFILES` back
  to `frozenset({"mac", "windows", "linux", "pi_cpu"})`. Rename
  `_PRE_MAPS_TOOLS` → `_PRE_MAPS_STACK` to reflect the JRE + two
  JARs. Ordering: JRE first (biggest download, ~50 MB, runs async
  alongside frontend build wouldn't work since it's sequential —
  place after `build-frontend`, before the LLM block, so a maps-only
  failure doesn't block an otherwise-working app boot). Gate the
  LLM + media block on nothing new; they run after the maps stack.
- `docs/maps-build.md` — rewrite top-to-bottom. Supersede the
  tippecanoe + Valhalla references. New sections: "What's in the
  stack" (JRE + planetiler + GraphHopper), "Per-region footprint"
  (copy the updated table from `PLAN.md`), "Windows support"
  (new — works end-to-end via the Java stack), "Troubleshooting"
  (OOM → lower heap via `LOKIDOKI_PLANETILER_HEAP_MB` /
  `LOKIDOKI_GRAPHHOPPER_HEAP_MB`, both new env vars introduced in
  chunks 2 + 3).
- `docs/roadmap/maps-local-build/PLAN.md` — add a SUPERSEDED banner
  at the top pointing at `docs/roadmap/maps-java-stack/PLAN.md`.
  Don't delete — the history matters for the chunk-6 lazy-sidecar
  rationale and the Geofabrik integration notes.
- `docs/roadmap/maps-local-build/chunk-1-toolchain.md` — add a note
  in the deferrals section: "Deferred indefinitely — superseded by
  maps-java-stack chunks 1-3. The `maps-tools-v1` GitHub Release
  was never cut; stub SHAs removed in maps-java-stack chunk 1."
- `tests/integration/test_maps_java_smoke.py` — new. Gated behind
  `LOKIDOKI_MAPS_SMOKE=1` env var (skipped in CI). Drives a real CT
  install via the FastAPI test client, waits for the SSE stream to
  hit `complete`, asserts `data/maps/ct/streets.pmtiles` +
  `data/maps/ct/graph-cache/` exist, POSTs a route request to
  `/api/v1/maps/route`, asserts the response has >0 maneuvers.
- `lokidoki/ui/settings/maps` — if any frontend copy still says
  "tippecanoe" or "Valhalla" in user-visible strings, update to
  the new tool names. Grep before editing — most copy is neutral.
- `CLAUDE.md` — no change required; the "Skills-First, LLM-Last"
  and "no apt/brew/choco" rules are satisfied by this stack.

## Actions

1. Flip `_MAPS_ENABLED_PROFILES`. Update the docstring in
   `build_steps()` to reflect the new three-step maps block.
2. Run the full bootstrap end-to-end on a **clean checkout**:
   ```bash
   rm -rf .lokidoki
   ./run.sh
   ```
   Expected sequence: python → uv → deps → node → frontend → JRE →
   planetiler → graphhopper → LLM → media → spawn-app. Every step
   green, elapsed time under 10 min on mac m-series (LLM download
   dominates — not new).
3. In the running app, install region CT via the Maps admin tab.
   Confirm the four phase chips advance (`downloading_pbf`,
   `building_geocoder`, `building_streets`, `building_routing`) and
   `complete` lands without error. Time target on mac: under 3 min
   total.
4. With CT installed: search "Hartford", drop a pin, get directions
   to another search result. Confirm turn-by-turn panel populates,
   alternate routes show, TTS readout works. Kill network; repeat
   — must still work (perfect-offline invariant).
5. Update `docs/maps-build.md` to match the new stack. Include a
   copy-paste `./run.sh --maps-tools-only` snippet that installs
   only the maps preflights (useful for CI / dev smoke).
6. Add the SUPERSEDED banner to the old plan + its chunk-1 note.
7. Run the full pytest suite:
   ```bash
   uv run pytest -q
   LOKIDOKI_MAPS_SMOKE=1 uv run pytest tests/integration/test_maps_java_smoke.py -x
   ```
   Both must be green.
8. Update the PLAN.md status table to all-`done`.

## Verify

```bash
# Clean-state bootstrap + smoke. Must be end-to-end green.
rm -rf .lokidoki
./run.sh --maps-tools-only
.lokidoki/tools/jre/bin/java -version
.lokidoki/tools/jre/bin/java -jar .lokidoki/tools/planetiler/planetiler.jar --help | head -1
.lokidoki/tools/jre/bin/java -jar .lokidoki/tools/graphhopper/graphhopper.jar --help | head -1

uv run pytest -q
LOKIDOKI_MAPS_SMOKE=1 uv run pytest tests/integration/test_maps_java_smoke.py -x
```

Manual UI verification (install CT, offline-search + route) is
**required** before flipping this chunk to `done`. Record the
observed timing in the commit body.

## Commit message

```
feat(maps): enable Java-stack maps on every profile

_MAPS_ENABLED_PROFILES flips back to mac + windows + linux + pi_cpu.
Bootstrap now auto-installs the Temurin JRE, planetiler.jar, and
graphhopper.jar on every profile; Windows is first-class for the
first time (tippecanoe + Valhalla both had broken Windows upstream
support — the Java stack doesn't).

docs/maps-build.md rewritten for the new stack. Old maps-local-build
plan marked SUPERSEDED with a pointer to maps-java-stack.

Live-verified on mac m-series: clean-checkout ./run.sh through
spawn-app in <10 min, CT install in <3 min, offline search + routing
functional.

Refs docs/roadmap/maps-java-stack/PLAN.md chunk 4.
```

## Deferrals section (append as you discover)

*(empty — leave for chunk-4 execution to fill)*
