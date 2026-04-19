# How LokiDoki Maps actually work offline

LokiDoki's Maps page is fully offline once a region is installed. There
is no CDN for pre-built map artifacts — everything is built on the
user's own device from a single public raw input: the Geofabrik
OpenStreetMap `.osm.pbf` for that region.

This page walks the full data flow, the per-region footprint, where
the toolchain binaries live on disk, why the Valhalla routing process
starts and stops on demand, and the most common install failures.

---

## What happens when you click Install

Settings → Maps → pick a region → Install. The admin panel opens an
SSE stream so every phase below reports real progress; the UI never
sits on a silent spinner.

1. **`downloading_pbf`** — stream the region's `.osm.pbf` from
   Geofabrik onto disk under `data/maps/<region>/.tmp/source.osm.pbf`.
   This is the only network call the install makes. Progress is
   reported in bytes against `region.pbf_size_mb`.

2. **`building_geocoder`** — run the FTS5 indexer over the PBF and
   write `data/maps/<region>/geocoder.sqlite`. This phase is first
   after the download (not last) on purpose: the address index is the
   fastest artifact to build, so search works in the UI while the
   heavier tippecanoe and Valhalla builds are still running.

3. **`building_streets`** — shell out to `tippecanoe`:

   ```
   tippecanoe -o streets.pmtiles -z14 --drop-densest-as-needed --force \
     -y height -y min_height -y building:levels -y building \
     source.osm.pbf
   ```

   The `-y` flags preserve OSM building attributes so the 3D buildings
   layer (Map / 3D toggle in the chip) can extrude them with real
   heights. Without those flags tippecanoe drops unknown tags and
   every building would render as a flat 1-story box.

4. **`building_routing`** — shell out to `valhalla_build_tiles` with
   a minimal on-the-fly `valhalla.json`, producing the tile tree under
   `data/maps/<region>/valhalla/`. Valhalla logs discrete phases
   (`initialize`, `parse ways`, `build graph`, …) which are forwarded
   to the SSE stream as sub-progress.

5. **`complete`** — the source PBF is deleted (it's no longer needed),
   `MapRegionState.streets_installed` / `geocoder_installed` /
   `routing_installed` flip to `True`, and `bytes_on_disk` is recorded
   per artifact.

Every phase is cancellable. Clicking Cancel sends SIGTERM to the
active subprocess, waits briefly for graceful exit, and deletes the
partial output. Nothing half-built ever lands in the final
`data/maps/<region>/` tree.

On-disk layout after a successful install:

```
data/maps/
  <region_id>/
    streets.pmtiles       # vector basemap (MapLibre reads via pmtiles://)
    geocoder.sqlite       # FTS5 address + place index
    valhalla/             # Valhalla routing tile tree
  catalog.json            # installed regions + their artifact sizes
```

---

## Per-region sizes and build times

These numbers come from the plan's authoritative footprint table
(`docs/roadmap/maps-local-build/PLAN.md`). Update that table, not
this one, if a measurement changes.

| Region           | PBF download | Build RAM peak | Build time (mac m-series) | Build time (Pi 5) | Final disk (streets + routing + geocoder) |
|------------------|-------------:|---------------:|--------------------------:|------------------:|------------------------------------------:|
| Small state (CT) | ~25 MB       | ~2 GB          | ~1–2 min                  | ~5–8 min          | ~160 MB                                   |
| Large state (CA) | ~300 MB      | ~4 GB          | ~5 min                    | ~20 min           | ~850 MB                                   |
| UK               | ~1.4 GB      | ~6 GB          | ~15 min                   | —                 | ~1.2 GB                                   |
| US (contig.)     | ~10 GB       | ~16 GB         | ~1 h                      | —                 | ~15 GB                                    |

A "—" in the Pi 5 column means the build won't fit in the Pi's 8 GB
of RAM. Those regions are gated in the catalog via the
`pi_local_build_ok` flag — attempting to install them on `pi_cpu` or
`pi_hailo` surfaces a clear error in the admin panel rather than
silently OOM-killing the build partway through.

The 3D buildings layer adds zero extra disk. It renders client-side
from the `building` source-layer already inside `streets.pmtiles`.

---

## Where the tools live

The installer never calls `apt` / `brew` / `choco`. Both toolchain
binaries arrive as pinned prebuilt archives fetched during bootstrap,
same pattern as Python / uv / Node / llama.cpp:

```
data/tools/
  tippecanoe/
    bin/tippecanoe
  valhalla/
    bin/valhalla_build_tiles
    bin/valhalla_service
```

Pins (URL template, per-`(os, arch)` filename, sha256) live in
`lokidoki/bootstrap/versions.py` under `TIPPECANOE` and
`VALHALLA_TOOLS`. The two preflight modules
(`lokidoki/bootstrap/preflight/tippecanoe.py` and
`lokidoki/bootstrap/preflight/valhalla_tools.py`) download, verify,
extract, smoke-test (`--version`), and prepend the `bin/` dirs to
`PATH` for the FastAPI process the same way `llama-cli` is patched
in.

Supported profiles: `mac` (darwin/arm64), `linux` (x86_64 and
aarch64). Windows x86_64 best-effort (tippecanoe upstream is flaky
there; the preflight skips with a clear message if no archive is
pinned).

To fetch just the map toolchain without re-running the full
bootstrap:

```bash
./run.sh --maps-tools-only
```

---

## Why Valhalla turns on and off

Valhalla is a sidecar process. Keeping it resident always would cost
100 MB – 800 MB of RSS (depending on how many regions you have
installed) — RAM that on a Pi 5 is better spent on the LLM. So
Valhalla is **lazy**:

- **Cold start** on the first `POST /api/v1/maps/route` request.
  Concurrent first-callers share a single spawn via an async lock.
  There is no silent warm-up on `/maps` page open — the start is
  driven by actual routing traffic.
- **Stay warm** while `/route` requests keep arriving. Every
  successful route call calls `lifecycle.touch()`, resetting the
  idle timer.
- **Shut down** after 15 minutes of no routing traffic. A background
  asyncio watchdog polls every 60 s, sends SIGTERM when idle, waits
  10 s, then SIGKILL if needed.

This lifecycle is driven by request traffic, not frontend UI state,
so the navigation skill's chat-triggered routes (e.g., the user
asking "directions from A to B" from the chat) also keep the process
warm and trigger a respawn on demand.

The default timeout is 900 s (15 min). `LOKIDOKI_VALHALLA_IDLE_S=N`
overrides it — useful for tests and for ops tuning.

Lifecycle implementation lives in
`lokidoki/maps/routing/lifecycle.py`; the Valhalla wrapper in
`lokidoki/maps/routing/valhalla.py` uses it transparently — API
callers see a normal `.route(req)` method.

---

## Troubleshooting

**Toolchain missing**
The install stream emits `error="toolchain_missing"` and the admin
panel shows "Re-run bootstrap — tippecanoe not on PATH" (or
`valhalla_build_tiles`). Run `./run.sh --maps-tools-only` to re-fetch
just the map tool archives, or `./run.sh` for the full bootstrap.
The binaries land under `data/tools/tippecanoe/bin/` and
`data/tools/valhalla/bin/`.

**Out of memory**
Exit code 137 from either build means the kernel's OOM killer fired.
The installer reports `error="out_of_memory"` and the admin panel
renders "Region too large for this device's RAM". The build left
nothing behind in `data/maps/<region>/` — the `.tmp/` dir was cleaned
up on exit. Pick a smaller region, or build on a beefier host and
sideload the artifacts.

**Build stuck**
tippecanoe and Valhalla both emit to stderr continuously; a "stuck"
install is almost always swap-thrashing near the RAM ceiling. Check
`top` / `htop`: if the tippecanoe or `valhalla_build_tiles` process
is consuming near-total memory and I/O wait is high, treat it as
out-of-memory even if the kernel hasn't killed it yet. Cancel from
the admin panel (clean exit, removes `.tmp/`) and either wait for a
moment when the LLM isn't loaded or pick a smaller region.

**Cancelled install**
Clicking Cancel SIGTERMs the active subprocess, waits briefly, and
deletes the `.tmp/` directory for the region. The final
`data/maps/<region>/` tree is left untouched unless all artifacts
completed before the cancel. `MapRegionState` flags accurately
reflect what made it to disk; re-clicking Install resumes from the
next-needed phase (the PBF re-downloads since it was cleaned on
cancel).
