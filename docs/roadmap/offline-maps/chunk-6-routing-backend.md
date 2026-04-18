# Chunk 6 — Offline routing backend: Valhalla sidecar per region

## Goal

Bring up a local Valhalla process that serves driving / walking / cycling directions against per-region routing tiles **downloaded prebuilt** as part of Chunk 2's region install (`data/maps/<region>/valhalla/`). After this chunk, the FastAPI backend exposes `/api/v1/maps/route` and `/api/v1/maps/eta` returning fully-offline Valhalla responses — shape-compatible with the remote OSRM responses `lokidoki/orchestrator/skills/navigation.py` currently consumes. The skill's `get_directions()` / `get_eta()` become local-first with the existing OSRM call as a fallback. No UI changes here — Chunk 7 builds the Directions panel on top of this API.

**Pi 5 is the primary deployment target.** Per PLAN.md's Pi constraints: **tile builds never run on Pi for country-scale regions** (OOMs on 8 GB). State-scale local builds are a dev/escape-hatch path behind a config flag; the default path on every platform is "download the `.tar.zst` of prebuilt tiles." This chunk's Valhalla runtime must also work within ~2 GB RSS serving a CT-sized region and up to ~6 GB serving a country-sized one.

## Why Valhalla (not OSRM / GraphHopper — decided in PLAN.md global context)

- Tiled storage runs a country-scale graph on <8 GB RAM (matters on Pi 5).
- One tile set serves `auto`, `pedestrian`, and `bicycle` profiles.
- Built-in localized turn-by-turn narrative (`maneuver.instruction`) — no `osrm-text-instructions` bolt-on.
- Permissive license; Docker image is first-party and maintained.

## Files

- `lokidoki/maps/routing/__init__.py` — new: `RouteRequest`, `RouteResponse`, `Maneuver` dataclasses; `RouterProtocol`.
- `lokidoki/maps/routing/valhalla.py` — new: `ValhallaRouter` — manages subprocess lifecycle (spawn Docker/native binary on first request, health-check, single in-flight union tile load), implements `route()` + `eta()` via HTTP to `http://127.0.0.1:8002/route`.
- `lokidoki/maps/routing/build_tiles.py` — new: `build_tiles(pbf_path, output_dir)` — runs `valhalla_build_config` + `valhalla_build_tiles` via subprocess (or the Docker image's CLI entrypoint); emits progress events on the Chunk-2 SSE stream; atomically swaps the per-region tile dir on completion.
- `lokidoki/maps/routing/online_fallback.py` — new: thin wrapper around the existing remote-OSRM call in `navigation.py`, only used when no installed region covers the origin or destination.
- `lokidoki/maps/store.py` — extend: after `build_index()` (Chunk 5) completes for a region, enqueue `build_tiles()`; on success, delete the `.pbf` iff both the geocoder and router are done with it. Update `MapRegionState` with `router_installed: true` + `router_bytes`.
- `lokidoki/api/routes/maps.py` — extend:
  - `POST /route` — body `{ origin: {lat,lon}, destination: {lat,lon}, waypoints?: [...], profile: "auto"|"pedestrian"|"bicycle", alternates?: int, avoid?: {highways?:bool, tolls?:bool, ferries?:bool} }` → Valhalla-formatted response.
  - `GET /eta?o_lat=&o_lon=&d_lat=&d_lon=&profile=auto` — thin wrapper that returns just `duration_s` + `distance_m`.
- `lokidoki/orchestrator/skills/navigation.py` — edit: `get_directions()` + `get_eta()` + `find_nearby()` call `/api/v1/maps/route` (and a future `/nearby` in a deferral) first; on `LocalRouterUnavailable` exception, fall back to existing remote OSRM / Overpass. Keep the external function signature byte-identical — no caller changes.
- `scripts/bench_routing.py` — new small script: warms Valhalla, runs 50 random intra-region routes, prints p50/p95/p99 latency.
- `tests/unit/test_valhalla_router.py` — new (mocks the HTTP call).
- `tests/unit/test_route_api.py` — new.
- `tests/unit/test_navigation_skill_local_first.py` — new (asserts the skill prefers local over remote).

Read-only: `lokidoki/bootstrap/versions.py` (we'll add a Valhalla version pin here — see Actions §1).

## Actions

### Runtime binary install

1. **Version pin**: add a `VALHALLA_RUNTIME` entry to `lokidoki/bootstrap/versions.py` with per-profile keys:
   ```python
   VALHALLA_RUNTIME = {
       "mac":       {"kind": "tarball", "url": "...valhalla-<ver>-darwin-arm64.tar.zst", "sha256": "..."},
       "linux":     {"kind": "tarball", "url": "...valhalla-<ver>-linux-x86_64.tar.zst", "sha256": "..."},
       "windows":   {"kind": "tarball", "url": "...valhalla-<ver>-windows-x86_64.tar.zst", "sha256": "..."},
       "pi_cpu":    {"kind": "tarball", "url": "...valhalla-<ver>-linux-aarch64.tar.zst", "sha256": "..."},
       "pi_hailo":  {"kind": "tarball", "url": "...valhalla-<ver>-linux-aarch64.tar.zst", "sha256": "..."},
   }
   VALHALLA_DOCKER_FALLBACK = {"image": "ghcr.io/gis-ops/docker-valhalla", "digest": "sha256:..."}  # multi-arch fork with aarch64 layers
   ```
   Since Valhalla upstream does not publish official static binaries, our offline-bundle build (`scripts/build_offline_bundle.py`) compiles Valhalla once per profile on a beefy build host and mirrors the resulting tarballs. See the offline bundle plan for the build recipe.
2. **Spawn strategy** in `ValhallaRouter._spawn()` — in priority order:
   1. If `.lokidoki/valhalla/valhalla_service` exists (tarball already extracted at bootstrap) → exec it directly with `--config data/maps/valhalla-config.json` and `--data-dir <union of installed regions>`.
   2. Else if `docker` CLI is on `$PATH` → `docker run --rm -d -p 8002:8002 -v data/maps:/data ${VALHALLA_DOCKER_FALLBACK.image}`.
   3. Else raise `ValhallaUnavailable` which the skill catches → online OSRM fallback kicks in.
   No binary extraction from a Docker image's root filesystem (prior draft). No building from source on-device — builds happen in the offline-bundle pipeline.
3. **Tile install** (`build_tiles.py`) — **default path is download, not build**:
   - Chunk 2's `install_region()` already downloaded and extracted the prebuilt `valhalla/` tile dir. This chunk's `ensure_tiles(region_id)` just validates the dir exists and has a `valhalla_tiles.tar` or equivalent inside.
   - Local build remains behind `allow_local_valhalla_build` (global config flag, default `False`) AND `region.pi_local_build_ok == True`. When both conditions are met and the user explicitly checks "Rebuild tiles from local PBF" in the region row's advanced menu, `valhalla_build_tiles` is invoked against `data/maps/<region>/source.osm.pbf`. On `pi_cpu` / `pi_hailo` with `pi_local_build_ok == False`, the checkbox is disabled with a tooltip *"Build requires >8 GB RAM — install the prebuilt tiles instead."*
   - SSE progress: `{artifact: "valhalla", phase: "downloading" | "extracting" | "building" | "ready"}`. Build phase only exists on the escape-hatch path.

### Runtime routing

4. **Union tile loading**: Valhalla loads every installed region's tile dir as a single union via its `additional_data.elevation` + `mjolnir.tile_dir` config; but tiles from different regions **do not cross-reference each other at the graph level**. Cross-region routes will fall back to online OSRM until we add a cross-region graph merge (explicitly deferred — see §Deferrals).
5. **`/route` endpoint**: pass-through the Valhalla JSON response but normalize the top-level keys to match what the existing `navigation.py` expected from OSRM (keep the same `routes[0].legs[0].steps[]` shape; map Valhalla's `maneuvers[]` to the step list). Add two non-OSRM fields we want on the client side: `instructions_text: string[]` (one entry per maneuver, from Valhalla's `instruction`), and `alternates: [{duration_s, distance_m, geometry}, ...]`.
6. **Navigation skill**: add a narrow try/except in `get_directions()`:
   ```python
   try:
       return await local_router.route(req)
   except LocalRouterUnavailable:
       return await remote_osrm.route(req)
   ```
   Same for `get_eta()`. Return value shape must not change — downstream prompts / TTS templates depend on it.

### Bench + tests

7. `scripts/bench_routing.py` — sample 50 origin/destination pairs uniformly from the installed region's bbox; print p50 / p95 / p99 route latency and peak RSS. Targets on Pi 5:
   - State-scale region (CT): p95 < 200 ms, RSS < 2 GB.
   - Country-scale region (US contig): p95 < 1.5 s, RSS < 6 GB.
   If either is missed, flag it in the commit body — the Directions panel UI in Chunk 7 degrades gracefully (loading spinner past 500 ms) but users feel >1 s everywhere.
8. `test_valhalla_router.py`: mock `httpx` responses; verify request body maps correctly per profile; verify retry on connection-refused + circuit break.
9. `test_route_api.py`: shape assertions; `avoid.highways` flag propagates; unknown profile → 400.
10. `test_navigation_skill_local_first.py`: monkeypatch both routers; assert local is tried first; assert remote is used when local raises `LocalRouterUnavailable`.

## Verify

```bash
uv run pytest tests/unit/test_valhalla_router.py tests/unit/test_route_api.py tests/unit/test_navigation_skill_local_first.py -x && \
uv run python -c "
# If CT router tiles exist, this should return a valid route between two CT points.
import asyncio, httpx
from fastapi.testclient import TestClient
from lokidoki.main import app
from pathlib import Path
client = TestClient(app)
if Path('data/maps/us-ct/valhalla').exists():
    r = client.post('/api/v1/maps/route', json={
        'origin': {'lat': 41.1412, 'lon': -73.3589},
        'destination': {'lat': 41.2429, 'lon': -73.0689},
        'profile': 'auto',
        'alternates': 2,
    })
    assert r.status_code == 200 and r.json()['routes'], r.text
    print('router OK — duration_s =', r.json()['routes'][0]['duration_s'])
else:
    print('no CT router tiles installed; backend-only tests sufficient')
"
```

## Commit message

```
feat(maps): offline routing — Valhalla against prebuilt per-region tiles

Adds lokidoki/maps/routing/ subsystem. Valhalla tiles arrive prebuilt
as a .tar.zst alongside streets.pmtiles in Chunk 2 — the Pi never
builds them (valhalla_build_tiles OOMs on 8 GB for country-scale
regions). Local tile build remains an escape-hatch behind a config
flag, disabled for any region flagged pi_local_build_ok=False.

Runtime binary comes as a per-profile tarball mirrored by the offline
bundle pipeline; falls back to a multi-arch Docker image when the
tarball isn't present. Both paths serve tiles via a 127.0.0.1:8002
HTTP endpoint the backend wraps with POST /api/v1/maps/route + GET
/eta, normalizing to OSRM-shaped responses and surfacing Valhalla's
built-in turn-by-turn instruction text.

The existing navigation skill's get_directions / get_eta become
local-first, with remote OSRM as fallback only when no region covers
the origin/destination or the runtime is unavailable. No
caller-visible signature change. Bench targets on Pi 5:
state-scale p95 <200 ms / <2 GB RSS; country-scale p95 <1.5 s /
<6 GB RSS.

Refs docs/roadmap/offline-maps/PLAN.md chunk 6.
```

## Deferrals section (append as you discover)

- **Cross-region routing.** Valhalla's default config loads each region's tile dir independently; a route from CT to CA across two separately-built tile sets will currently fall back to online OSRM. A unioned graph means re-publishing a single multi-region tile bundle from the build host — install-footprint math changes, so do not bolt it on here.
- **`find_nearby` offline.** Overpass is still used for nearby-category search. Valhalla's `/locate` doesn't cover POI categories. Add a POI extractor to `fts_index.py` and a `/nearby` endpoint in a follow-up.
- **Offline-bundle build host + publishing pipeline.** This chunk consumes prebuilt Valhalla tarballs + per-region tile archives from a CDN URL; it does **not** implement the build host that produces them. That belongs in the offline-bundle plan (`scripts/build_offline_bundle.py` already pre-downloads pinned artifacts — add Valhalla runtime + per-region tiles to its manifest). Flag in the commit body which CDN URLs are stubs until the bundle pipeline catches up.
