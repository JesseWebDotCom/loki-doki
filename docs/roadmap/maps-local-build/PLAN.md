# Offline Maps via Local Build — Execution Plan

Goal: `./run.sh` produces a working LokiDoki in which the Maps page is
offline-capable out of the box. A user with zero internet (after the
initial region install) can search, drop pins, get directions, and see
vector tiles render for every installed region. **No remote CDN for
pre-built map artifacts** — the app downloads the raw OpenStreetMap
PBF from Geofabrik (a real, long-standing public service), then runs
`tippecanoe` and `valhalla_build_tiles` locally to produce the PMTiles
vector basemap, the Valhalla routing graph, and the FTS5 geocoder.
Instead of satellite imagery (infeasible offline — see Non-goals),
the map ships a **3D buildings** layer with pitch/tilt, rendered by
MapLibre's native `fill-extrusion` paint over the OSM `building=*`
features that are already in the PMTiles we built anyway — zero
extra downloads, zero licensing concerns.

This plan supersedes the artifact-hosting assumption made in
[docs/roadmap/offline-maps/PLAN.md](../offline-maps/PLAN.md) (chunks
1–7, all shipped). The UI from that plan stays as-is; only the
install pipeline changes.

---

## How to use this document (Claude Code operating contract)

You are a fresh Claude Code session. You have been pointed at this
file and given no other instructions.

**Do exactly this:**

1. Read the **Status** table below. Pick the **first** chunk whose
   status is `pending` — call it Chunk N.
2. Open `chunk-N-*.md` and read it completely. **Do not open any
   other chunk doc.**
3. Execute every step in its `## Actions` section.
4. Run the command in its `## Verify` section. If it fails, do not
   proceed — diagnose or record the block and stop. Do not fake
   success.
5. If verify passes:
   - Stage only the files the chunk touched.
   - Commit using the template in the chunk's `## Commit message`
     section. Follow `memory/feedback_no_push_without_explicit_ask.md`
     — **commit only; do not push, open a PR, or merge.**
   - Edit this `PLAN.md`: flip the chunk's row from `pending` to
     `done` and paste the commit SHA in the `Commit` column.
   - If during execution you discovered work that had to be pushed
     to a later chunk, append a `## Deferred from Chunk N` bullet
     list to that later chunk's doc with the specifics.
6. **Stop.** Do not begin the next chunk in the same session. Each
   chunk gets its own fresh context.

**If blocked** (verify keeps failing, required file is missing, intent
of the chunk is unclear): leave the chunk status as `pending`, write
a `## Blocker` section at the bottom of that chunk's doc explaining
what's wrong, and stop. Do not guess.

**Scope rule**: only touch files listed in the chunk doc's `## Files`
section. If work sprawls beyond that list, stop and defer the sprawl
to a later chunk.

---

## Status

| # | Chunk                                                                                   | Status  | Commit |
|---|-----------------------------------------------------------------------------------------|---------|--------|
| 1 | [Pin tippecanoe + valhalla prebuilt binaries via bootstrap](chunk-1-toolchain.md)       | done    | 6b2bd54 |
| 2 | [Rewrite maps catalog — drop CDN fields, keep Geofabrik PBF](chunk-2-catalog.md)        | done    | 0876365 |
| 3 | [Rewrite install_region to build locally](chunk-3-install-local.md)                     | done    | 7fe5b61 |
| 4 | [Frontend cleanup — new progress phases, remove stub-dist banner](chunk-4-frontend.md)  | done    | cf43c81 |
| 5 | [3D buildings + pitch/tilt control (replaces satellite)](chunk-5-3d-buildings.md)       | done    | aea42fd |
| 6 | [Lazy Valhalla sidecar lifecycle](chunk-6-lazy-router.md)                               | pending |        |
| 7 | [Documentation + supersede offline-maps chunk 8a](chunk-7-docs.md)                      | pending |        |

---

## Global context (read once, applies to every chunk)

### What this plan replaces

The offline-maps plan (`docs/roadmap/offline-maps/PLAN.md`, chunks
1–7, all done) built the install pipeline and UI assuming a remote
CDN at `https://dist.lokidoki.app/maps` would publish pre-built per-
region PMTiles / satellite / Valhalla tarballs. That CDN was never
stood up. Chunk 6 of that plan explicitly flagged it as a deferral;
sub-chunk 8a partially papered over it with a
`LOKIDOKI_MAPS_DIST_BASE` env override + self-host docs. Neither made
the feature actually work out of the box.

This plan scraps the remote-CDN design.

### What stays (do not touch unless a chunk says so)

- Every piece of the Apple Maps-style UI from offline-maps chunks 3,
  4, and 7 — left rail, Search panel, place-details card, directions
  panel with alternates and turn-by-turn, TTS readout.
- FTS5 geocoder code from offline-maps chunk 5.
- Valhalla as the routing engine; MapLibre GL as the renderer;
  Protomaps PMTiles as the tile format.
- Per-region selection, install/uninstall, progress SSE stream,
  out-of-coverage banner.
- Geofabrik as the OSM data source (`_GEOFABRIK` in
  [lokidoki/maps/seed.py](../../../lokidoki/maps/seed.py) already
  points at the real public URL).

### What changes

- `MapRegion` loses every CDN-derived field: `street_url_template`,
  `street_sha256`, `satellite_*` (all of them — satellite is fully
  dropped), `valhalla_url_template`, `valhalla_sha256`.
  `pbf_url_template` + `pbf_sha256` stay — it's the only real
  download.
- The satellite admin tab, the `/api/v1/maps/tiles/<region>/sat/...`
  route, `LayerModeChip`'s satellite/hybrid modes, and
  `InstalledRegion.has_satellite` all go away. A new `3D` mode
  replaces them in the chip.
- `install_region` downloads the PBF, then runs tippecanoe and
  `valhalla_build_tiles` as subprocesses. No tarball extraction.
- Bootstrap pins tippecanoe + valhalla prebuilt binaries per profile
  (mac arm64, linux x86_64, linux arm64 aka pi) — mirrored as GitHub
  Release assets on the `loki-doki` repo, same pattern as llama.cpp.
- Sub-chunk 8a's `LOKIDOKI_MAPS_DIST_BASE` env var, stub-dist banner,
  and self-host doc (`docs/maps-dist.md`) are removed; replaced by
  `docs/maps-build.md`.
- Install progress phases become `downloading_pbf` →
  `building_geocoder` → `building_streets` → `building_routing` →
  `complete`. Geocoder is built first so search works during the
  longer tippecanoe/valhalla runs.
- Valhalla sidecar becomes lazy: starts on first `/route` request,
  shuts down after 15 min idle.

### Pi 5 constraints (unchanged — violate and the plan silently breaks)

- 8 GB RAM shared with LLM, vision, TTS, FastAPI.
- **No `apt` / `brew` / `choco`** (AGENTS.md hard rule). All toolchain
  binaries arrive as pinned prebuilt archives, same pattern as
  [lokidoki/bootstrap/versions.py](../../../lokidoki/bootstrap/versions.py)
  already uses for Python, uv, Node, llama.cpp.
- Tippecanoe building CT-scale PMTiles: ~2 GB RAM peak, ~3 min.
- `valhalla_build_tiles` for CT-scale region: ~2–4 GB RAM peak, ~5 min.
- Country-scale regions (UK, contig US): still forbidden for local
  build on Pi — `pi_local_build_ok` catalog flag from offline-maps
  chunk 2 stays. Regions that fail it surface a clear error when the
  user tries to install them on Pi hardware.
- 3D buildings: rendered client-side from vector-tile attributes
  already in the PMTiles. Zero extra RAM on the Pi; extra cost is
  GPU fragments on the browser side, which LokiDoki doesn't run.
- No GPU for tile rendering on the Pi itself (browser WebGL only).
- Hailo NPU off-limits for maps.

### Hard rules (do not violate)

- Perfect-offline once a region is installed. No network calls from
  the Maps page within covered viewport.
- No remote CDN for map artifacts anywhere in the code after chunk 2
  lands. Grep-auditable: zero occurrences of `dist.lokidoki.app`
  outside archived history.
- No new browser dialogs — use
  [ConfirmDialog.tsx](../../../frontend/src/components/ui/ConfirmDialog.tsx)
  per AGENTS.md:144.
- Subprocess calls (tippecanoe, valhalla_build_tiles) must be
  cancellable mid-build and leave no corrupt state on disk.
- Every install step must stream progress over the existing SSE
  endpoint; no silent "10-minute spinner".
- Tippecanoe / valhalla binaries install under `data/tools/` next to
  the existing bootstrap toolchain. `PATH` is patched by the same
  mechanism `llama-cli` uses today.

---

## Per-region footprint estimates (authoritative; update Chunk 3 if changed)

| Region           | PBF download | Build RAM peak | Build time on mac m-series | Build time on Pi 5 | Final disk (streets + routing + geocoder) |
|------------------|-------------:|---------------:|---------------------------:|-------------------:|------------------------------------------:|
| Small state (CT) | ~25 MB       | ~2 GB          | ~1–2 min                   | ~5–8 min           | ~160 MB                                   |
| Large state (CA) | ~300 MB      | ~4 GB          | ~5 min                     | ~20 min            | ~850 MB                                   |
| UK               | ~1.4 GB      | ~6 GB          | ~15 min                    | — (PBF too big)    | ~1.2 GB                                   |
| US (contig.)     | ~10 GB       | ~16 GB         | ~1 h                       | — (OOM)            | ~15 GB                                    |

3D buildings add no disk — they render from the `building` feature
layer already in `streets.pmtiles` (produced by tippecanoe with
`height`, `building`, `min_height` attributes preserved).

---

## Non-goals (for this plan — may land later)

- Build-farm infrastructure. All builds are on the end-user's device.
- Country-scale or continent-scale regions on Pi 5 (physically
  infeasible).
- **Offline satellite imagery** — not achievable at usable quality
  without paid tile-provider access (Mapbox / MapTiler) or a
  US-only path via USGS NAIP. Revisit as a future chunk if a
  legitimate data source emerges; for v1, the 3D-buildings layer
  is the aerial alternative.
- Live traffic, transit GTFS — already non-goals of the offline-maps
  plan.
- Full voice-nav with GPS reroute — chunk 8f of the offline-maps
  rollup, unchanged by this plan.

---

## NOTE (append as chunks land)

*(empty — chunks add cross-chunk notes or deferrals here)*
