# Chunk 3 — GraphHopper preflight + replace Valhalla routing

## Goal

After this chunk, region install uses GraphHopper (not
`valhalla_build_tiles`) to produce the routing graph, and `/route` /
`/eta` calls are answered by a lazy GraphHopper sidecar (not
`valhalla_service`). A new `install-graphhopper` preflight downloads
the pinned `graphhopper-web-<v>.jar` from Maven Central to
`data/tools/graphhopper/graphhopper.jar`. The sidecar still listens on
`:8002`, still lazy-starts on first route call, still idle-shuts-down
after `LOKIDOKI_VALHALLA_IDLE_S` (env var renamed to
`LOKIDOKI_ROUTER_IDLE_S`, with the old name honoured as a fallback so
in-flight configs don't break).

Prereqs: chunk 1 (JRE) and chunk 2 (planetiler wired, install flow
produces streets.pmtiles).

## Files

- `lokidoki/bootstrap/versions.py` — add `GRAPHHOPPER` spec:
  ```python
  GRAPHHOPPER = {
      "version": "10.1",
      "filename": "graphhopper-web-10.1.jar",
      "sha256": "<sha256>",
      "url_template": (
          "https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/"
          "{version}/{filename}"
      ),
  }
  ```
- `lokidoki/bootstrap/preflight/graphhopper.py` — new. Same shape as
  the planetiler preflight from chunk 2: download JAR, sha verify,
  `java -jar <jar> --help` smoke test.
- `lokidoki/bootstrap/context.py` — add `"graphhopper_jar"` to
  `_LAYOUT` with the same path pattern planetiler used.
- `lokidoki/bootstrap/steps.py` — register `install-graphhopper` in
  `_REAL_RUNNERS` / `_STEP_CATEGORY` (category `"system"`). Extend
  `build_maps_tools_only_steps()` to `[detect-profile, install-jre,
  install-planetiler, install-graphhopper]`. Profile enablement still
  off until chunk 4.
- `lokidoki/maps/build.py` — replace `run_valhalla` with
  `run_graphhopper_import`. Same signature. Invocation:
  `java -Xmx<heap> -jar <graphhopper.jar> import <pbf>` with a
  prebuilt `config.yml` that pins the `graph.location` to
  `out_dir/graph-cache`, turns off elevation lookups (offline
  constraint), and enables bike + pedestrian + car profiles so the
  existing `RouterProfile` enum keeps working. Parse GraphHopper's
  import progress lines (prefixed `INFO  com.graphhopper.…`) into
  `MapInstallProgress` events for the `building_routing` phase.
  Heap: `pi_cpu` → 2048, `mac` → 6144, `linux`/`windows` → 4096
  (reuse the dict chunk 2 added).
- `lokidoki/maps/routing/valhalla.py` → **rename to** `graphhopper.py`.
  Rewrite the `route` / `eta` HTTP calls against GraphHopper's
  `/route` JSON API (different request + response shape from
  Valhalla's). Keep the `RouterProtocol` surface identical — every
  caller (`navigation_skill`, `route_api`) sees the same request /
  response models. Map GraphHopper response to the existing
  `RouteResponse` / `Maneuver` / `RouteAlternate` dataclasses in
  `lokidoki/maps/routing/__init__.py`. The turn-by-turn `instructions`
  array from GraphHopper already carries `text`, `distance`, `time`,
  `sign`; map `sign` enum values to `Maneuver.type`. The HTTP port
  (`:8002`) stays the same so `lifecycle.py`'s watchdog doesn't need
  to change.
- `lokidoki/maps/routing/lifecycle.py` — rename `ValhallaLifecycle`
  class → `RouterLifecycle`. Spawn command changes from
  `valhalla_service <config>` to
  `java -Xmx<heap> -jar <graphhopper.jar> server <config.yml>` (the
  same yaml used for import, pointed at the already-built
  `graph-cache`). Idle-shutdown semantics unchanged.
  `LOKIDOKI_VALHALLA_IDLE_S` becomes `LOKIDOKI_ROUTER_IDLE_S`;
  honour the old name as fallback for one release.
- `lokidoki/maps/routing/__init__.py` — update exception names
  (`ValhallaUnavailable` → `RouterUnavailable`) and re-export
  `RouterUnavailable` under the old name for one release so nothing
  breaks at import time.
- `lokidoki/maps/routing/build_tiles.py` — module body becomes a
  tile-dir-layout validator for GraphHopper's `graph-cache/` dir
  instead of Valhalla's tile tree. Keep the `ensure_tiles` public
  name.
- `lokidoki/maps/routing/online_fallback.py` — unchanged in shape;
  just verify it still wires in via the renamed `RouterProtocol`.
- `lokidoki/maps/store.py` — rename the `building_routing` phase
  handler to call `build.run_graphhopper_import` instead of
  `build.run_valhalla`. Phase string unchanged.
- `tests/unit/test_valhalla_router.py` → **rename to**
  `test_graphhopper_router.py`. Rewrite fixtures to the GraphHopper
  `/route` response shape. Same assertions: happy path, alternate
  routes, turn-by-turn, bike/pedestrian profile.
- `tests/unit/test_route_api.py` — no source-import changes thanks
  to the re-export shim; update fixture payloads if any mock the
  Valhalla response shape directly.
- `tests/unit/test_maps_build.py` — rename
  `test_run_valhalla_*` → `test_run_graphhopper_import_*`, swap
  progress line fixtures.
- `tests/unit/test_maps_store.py` — mock symbol change:
  `build.run_valhalla` → `build.run_graphhopper_import`.
- `tests/unit/test_navigation_skill_local_first.py` — update any
  symbol references that grep for `valhalla`. The skill-level
  behavior (local-first, fallback to remote) is unchanged.
- `tests/unit/bootstrap/test_preflight_graphhopper.py` — new.
- `tests/unit/bootstrap/test_versions.py` — add GraphHopper
  assertions.

## Actions

1. Pull `graphhopper-web-10.1.jar` once, record sha256, update
   `versions.py`. Confirm Maven Central's URL shape (lowercase
   artifact id, version segment repeated in filename).
2. Write the preflight; mirror the planetiler one from chunk 2.
3. Draft a minimal `graphhopper-config.yml` template. Store in the
   repo at `lokidoki/maps/routing/graphhopper_config_template.yml`
   (read-only; no user-editable secrets). Minimum settings:
   ```yaml
   graphhopper:
     datareader.file: "{pbf_path}"
     graph.location: "{graph_cache_dir}"
     profiles:
       - name: car
         vehicle: car
         weighting: fastest
       - name: bike
         vehicle: bike
         weighting: fastest
       - name: foot
         vehicle: foot
         weighting: shortest
   server:
     application_connectors:
       - type: http
         port: 8002
         bind_host: 127.0.0.1
   ```
   Format-template at runtime with the region's concrete paths.
4. `build.py::run_graphhopper_import`:
   - Write the templated yaml to `out_dir/graphhopper-config.yml`.
   - Command: `[java, f"-Xmx{heap_mb}m", "-jar", gh_jar, "import",
     str(config_path)]`.
   - Stream stdout/stderr; parse progress from GraphHopper's log
     prefix format. Map `DataReaderOSM` phase → 0–40 %,
     `GraphStorage` → 40–80 %, `CHPreparation` → 80–100 %.
   - OOM classification: same substring check as planetiler.
5. Rewrite `routing/valhalla.py` → `graphhopper.py`:
   - Request body for GraphHopper:
     ```json
     {"points": [[lon1,lat1],[lon2,lat2]],
      "profile": "car",
      "instructions": true,
      "points_encoded": false,
      "algorithm": "alternative_route",
      "alternative_route.max_paths": 3}
     ```
   - Parse response: `paths[]` → `RouteAlternate[]`; `paths[0]` →
     primary `RouteResponse`. `instructions[]` → `Maneuver[]` with
     `sign` → `Maneuver.type` mapping table (keep the mapping
     inline — it's ~15 cases, no abstraction).
6. Rewrite `routing/lifecycle.py`: spawn command + env var name
   change. Keep port, idle timeout, watchdog lock, logging hooks.
7. Update `store.py` call site, error codes unchanged.
8. Tests: a lot of renames. Use `grep -l valhalla` to find every
   test that needs a symbol update. Don't rename anything outside
   `lokidoki/maps/routing/` and `tests/` — the skill layer imports
   `RouterProtocol`, which stays named the same.

## Verify

```bash
uv run pytest tests/unit/bootstrap/test_preflight_graphhopper.py \
              tests/unit/bootstrap/test_versions.py \
              tests/unit/test_maps_build.py \
              tests/unit/test_maps_store.py \
              tests/unit/test_graphhopper_router.py \
              tests/unit/test_route_api.py \
              tests/unit/test_navigation_skill_local_first.py -x -q

./run.sh --maps-tools-only
.lokidoki/tools/jre/bin/java -jar \
  .lokidoki/tools/graphhopper/graphhopper.jar --help | head -5
```

Live route verification waits for chunk 4's end-to-end pass.

## Commit message

```
feat(maps): replace Valhalla with GraphHopper

New install-graphhopper preflight pulls graphhopper-web.jar from
Maven Central. Region install's building_routing phase now invokes
java -jar graphhopper.jar import; the lazy sidecar spawns
java -jar graphhopper.jar server on the same :8002 port, preserving
the idle-shutdown lifecycle chunk 6 of maps-local-build introduced.

RouterProtocol surface is unchanged so the navigation skill, route
API, and online-fallback path keep working. LOKIDOKI_VALHALLA_IDLE_S
is renamed to LOKIDOKI_ROUTER_IDLE_S with a one-release fallback.

Refs docs/roadmap/maps-java-stack/PLAN.md chunk 3.
```

## Deferrals section (append as you discover)

*(empty — leave for chunk-3 execution to fill)*
