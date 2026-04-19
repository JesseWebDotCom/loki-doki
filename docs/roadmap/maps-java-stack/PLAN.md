# Offline Maps on a Cross-Platform Java Stack — Execution Plan

Goal: Maps works on **every supported profile including Windows**,
hands-off from `./run.sh`, with zero third-party binaries redistributed
by us. Replace the non-existent `maps-tools-v1` tippecanoe + Valhalla
release assets with upstream-hosted Java tooling the bootstrap downloads
dynamically at install time: planetiler (PMTiles) + GraphHopper
(routing) + Adoptium Temurin JRE (runtime). Every fetch is a pinned URL
+ sha256 from each project's own upstream distribution, same pattern
`lokidoki/bootstrap/versions.py` already uses for uv, Node, llama.cpp.

This plan supersedes chunk 1 of
[docs/roadmap/maps-local-build/PLAN.md](../maps-local-build/PLAN.md).
The Apple Maps-style UI from offline-maps chunks 3/4/7 stays. The
four-phase install stays (`downloading_pbf` → `building_geocoder` →
`building_streets` → `building_routing` → `complete`). Only the two
subprocess calls and one preflight pair change.

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

| # | Chunk                                                                                              | Status  | Commit |
|---|----------------------------------------------------------------------------------------------------|---------|--------|
| 1 | [Adoptium Temurin JRE preflight](chunk-1-jre-preflight.md)                                         | done    | d1dcebc |
| 2 | [planetiler preflight + replace tippecanoe in install flow](chunk-2-planetiler.md)                 | done | 0572220 |
| 3 | [GraphHopper preflight + replace Valhalla in routing + lazy sidecar rewire](chunk-3-graphhopper.md)| done | efd7069 |
| 4 | [Re-enable maps profiles + end-to-end verify + docs update](chunk-4-enable-and-docs.md)            | pending |        |

---

## Global context (read once, applies to every chunk)

### What the current repo state is

- `_MAPS_ENABLED_PROFILES = frozenset()` in
  [lokidoki/bootstrap/steps.py](../../../lokidoki/bootstrap/steps.py)
  — maps preflights are disabled for every profile as of commit
  `0360f99`. Bootstrap completes. The Maps UI still renders but any
  install attempt returns a toolchain-missing error.
- The `install-tippecanoe` + `install-valhalla-tools` preflights,
  their `TIPPECANOE` + `VALHALLA_TOOLS` entries in
  [lokidoki/bootstrap/versions.py](../../../lokidoki/bootstrap/versions.py),
  and the `_PRE_MAPS_TOOLS` spec list still exist but are unreferenced
  from `build_steps()`. This chunk plan **removes** them.
- [lokidoki/maps/build.py](../../../lokidoki/maps/build.py) still
  shells out to `tippecanoe` + `valhalla_build_tiles`. This chunk plan
  **replaces both subprocess calls** with Java invocations.
- [lokidoki/maps/routing/valhalla.py](../../../lokidoki/maps/routing/valhalla.py)
  + [lifecycle.py](../../../lokidoki/maps/routing/lifecycle.py)
  operate a lazy Valhalla sidecar on `:8002`. This chunk plan
  **replaces** the Valhalla sidecar with an equivalent GraphHopper
  sidecar on the same port, preserving the lazy / idle-shutdown
  semantics of chunk 6 of maps-local-build.
- The FTS5 geocoder, the PMTiles/MapLibre frontend, the 3D buildings
  layer, the admin UI, the `install_region` phase state machine, and
  the Geofabrik PBF download all stay untouched.

### What this plan replaces

- **tippecanoe → planetiler.** Single fat JAR downloaded from
  planetiler's own GitHub Release. Consumes the same Geofabrik PBF
  and produces a single `streets.pmtiles` at the same path
  (`data/maps/<region>/streets.pmtiles`). Preserves OSM `building`,
  `height`, `min_height`, `building:levels` attributes for the 3D
  buildings layer (chunk 5 of maps-local-build depends on them).
- **Valhalla build + sidecar → GraphHopper.** Single fat JAR
  downloaded from GraphHopper's own Maven Central release. One
  invocation (`import`) builds the routing graph from the PBF; a
  second invocation (`server`) runs the REST API. Port `:8002`
  preserved; lazy-start + idle-shutdown lifecycle preserved.
- **Two prebuilt-archive preflights → one JRE preflight + two JAR
  download preflights.** All three fetch from upstream, not from us.

### What each new dep brings

| Dep | Source | Size | Licence | Platforms |
|-----|--------|-----:|--------|-----------|
| Adoptium Temurin JRE 21 LTS | `https://api.adoptium.net/v3/binary/...` | ~50 MB | GPLv2 w/ CE | mac arm64, linux x64, linux arm64 (Pi), **windows x64** |
| planetiler-dist.jar | `https://github.com/onthegomap/planetiler/releases/...` | ~15 MB | Apache 2.0 | Any JRE |
| graphhopper-web-*.jar | `https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/<v>/graphhopper-web-<v>.jar` | ~40 MB | Apache 2.0 | Any JRE |

All three projects publish prebuilt release assets on their own
infrastructure. We pin URL + sha256 only — no mirror.

### Architectural invariants (do not violate)

- **Perfect-offline once a region is installed.** No network calls
  from the Maps page within covered viewport.
- **No third-party binaries in our repo or our GitHub Releases.**
  Every fetch is a pinned URL to the upstream project's own
  distribution. Grep-auditable: zero occurrences of
  `JesseWebDotCom/loki-doki/releases/download/maps-tools-*` anywhere
  in source after chunk 4 lands.
- **Windows parity.** Chunks 1–3 must verify on a Windows path, even
  if you only execute verify on mac. The JRE, planetiler, and
  GraphHopper all officially support Windows x64.
- **No new browser dialogs** — use
  [ConfirmDialog.tsx](../../../frontend/src/components/ui/ConfirmDialog.tsx)
  per AGENTS.md.
- **Subprocess calls must be cancellable mid-build** and leave no
  corrupt state on disk (invariant from maps-local-build chunk 3).
- **Every install step streams progress** over the existing SSE
  endpoint; no silent spinner.
- **JRE + JARs install under `data/tools/`** next to the existing
  bootstrap toolchain. `PATH` is patched by the same mechanism
  `llama-cli` uses today — NOT the system `java` if one is present.
- **Hailo NPU off-limits for maps.** Unchanged.

### Per-region footprint (authoritative — update chunk 2 / 3 if changed)

| Region           | PBF download | planetiler RAM | planetiler time (mac m-series) | planetiler time (Pi 5) | GH import RAM | GH import time (Pi 5) | Final disk |
|------------------|-------------:|---------------:|-------------------------------:|----------------------:|--------------:|---------------------:|-----------:|
| Small state (CT) | ~25 MB       | ~1.5 GB        | ~1 min                         | ~4 min                | ~1 GB         | ~3 min               | ~150 MB    |
| Large state (CA) | ~300 MB      | ~3 GB          | ~3 min                         | ~15 min               | ~3 GB         | ~12 min              | ~800 MB    |
| UK               | ~1.4 GB      | ~5 GB          | ~10 min                        | — (too big)           | ~4 GB         | — (too big)          | ~1.1 GB    |
| US (contig.)     | ~10 GB       | ~12 GB         | ~45 min                        | — (OOM)               | ~12 GB        | — (OOM)              | ~14 GB     |

`pi_local_build_ok` catalog flag stays authoritative for what Pi can
handle. Numbers above are estimates to seed chunk 2 / 3; retest once
planetiler + GH are wired.

### Non-goals (for this plan — may land later)

- Replacing MapLibre / PMTiles on the frontend. planetiler produces
  the same output format; the frontend is untouched.
- Country-scale or continent-scale regions on Pi 5 (physically
  infeasible — same limit as current stack).
- Live traffic, transit GTFS — still non-goals.
- Pure-voice-nav with GPS reroute — unchanged (chunk 8f of the
  offline-maps rollup).

### Pinned upstream versions (seed; chunk 1 re-verifies)

| Name | Pinned version | Why this version |
|------|---------------:|------------------|
| Temurin JRE | 21.0.5+11 | Latest LTS as of 2026-04-19; planetiler + GH both require JRE 17+. |
| planetiler | 0.8.4 | Latest stable release with PMTiles output built in. |
| GraphHopper | 10.1 | Latest stable; Java 21 compatible; includes turn-by-turn directions JSON shape our UI already consumes. |

Chunk 1 re-checks these before freezing SHAs.

---

## NOTE (append as chunks land)

*(empty — chunks add cross-chunk notes or deferrals here)*
