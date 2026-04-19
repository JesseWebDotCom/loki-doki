# How LokiDoki Maps work offline on the Java stack

LokiDoki's Maps page is fully offline once a region is installed. The
only network download during region install is the Geofabrik
OpenStreetMap `.osm.pbf`. Every runtime artifact after that is built or
served locally from disk.

The current maps stack is:

- Temurin JRE 21 LTS for a pinned local Java runtime.
- `planetiler.jar` to turn the region PBF into `streets.pmtiles`.
- `graphhopper.jar` to import and serve the local routing graph.
- The existing FTS5 geocoder for search.

Bootstrap installs the JRE and both JARs under `.lokidoki/tools/`, and
the FastAPI app uses those embedded tools rather than the system Java.

---

## What's in the stack

Bootstrap fetches the maps toolchain plus the planetiler source
archives (Natural Earth + OSM water polygons) during the maps block.
The source archives are what planetiler's `--download` flag normally
pulls at build time — pre-seeding them here keeps `building_streets`
offline:

```text
.lokidoki/tools/
  jre/
    bin/java
  planetiler/
    planetiler.jar
    sources/
      natural_earth_vector.sqlite.zip
      water-polygons-split-3857.zip
  graphhopper/
    graphhopper.jar
```

The preflight pins live in `lokidoki/bootstrap/versions.py`, and the
maps block is part of the normal bootstrap flow on `mac`, `windows`,
`linux`, and `pi_cpu`.

To fetch only the maps stack during local development or CI:

```bash
./run.sh --maps-tools-only
```

That path installs the embedded JRE, `planetiler.jar`, the
planetiler source archives, and `graphhopper.jar`, then exits.

---

## Install phases

Settings → Maps → pick a region → Install. The admin panel opens an SSE
stream so each phase reports live progress:

1. `downloading_pbf` downloads the region's Geofabrik `.osm.pbf` into
   `data/maps/<region>/.tmp/`.
2. `building_geocoder` builds `data/maps/<region>/geocoder.sqlite` so
   local search is available before the longer map/routing builds end.
3. `building_streets` runs `planetiler.jar` and writes
   `data/maps/<region>/streets.pmtiles`.
4. `building_routing` runs `graphhopper.jar import` and writes
   `data/maps/<region>/valhalla/graph-cache/`.
5. `complete` records final bytes-on-disk and deletes the source PBF
   unless `LOKIDOKI_KEEP_PBF=1` is set.

Every phase is cancellable. If the install fails or is cancelled,
partial outputs are removed so `data/maps/<region>/` never contains a
half-built PMTiles file or routing graph.

On-disk layout after a successful install:

```text
data/maps/
  <region_id>/
    streets.pmtiles
    geocoder.sqlite
    valhalla/
      graph-cache/
```

The `valhalla/` directory name is a compatibility holdover in the data
layout; the contents are now GraphHopper graph-cache files.

---

## Per-region footprint

These numbers come from the authoritative table in
`docs/roadmap/maps-java-stack/PLAN.md`.

| Region           | PBF download | planetiler RAM | planetiler time (mac m-series) | planetiler time (Pi 5) | GH import RAM | GH import time (Pi 5) | Final disk |
|------------------|-------------:|---------------:|-------------------------------:|----------------------:|--------------:|---------------------:|-----------:|
| Small state (CT) | ~25 MB       | ~1.5 GB        | ~1 min                         | ~4 min                | ~1 GB         | ~3 min               | ~150 MB    |
| Large state (CA) | ~300 MB      | ~3 GB          | ~3 min                         | ~15 min               | ~3 GB         | ~12 min              | ~800 MB    |
| UK               | ~1.4 GB      | ~5 GB          | ~10 min                        | — (too big)           | ~4 GB         | — (too big)          | ~1.1 GB    |
| US (contig.)     | ~10 GB       | ~12 GB         | ~45 min                        | — (OOM)               | ~12 GB        | — (OOM)              | ~14 GB     |

A `—` in the Pi column means the build does not fit on Pi 5 hardware.
The catalog's `pi_local_build_ok` flag remains the source of truth for
what the Pi is allowed to build locally.

The 3D buildings layer adds no extra disk footprint. It renders from
building attributes already preserved inside `streets.pmtiles`.

---

## Windows support

The Java stack is the first maps toolchain in LokiDoki that is meant to
work end-to-end on Windows. `tippecanoe` and Valhalla never had a
reliable Windows bootstrap story; the current stack avoids that by
using:

- Temurin JRE 21 for the Java runtime.
- `planetiler.jar` for PMTiles generation.
- `graphhopper.jar` for import and routing service.

The same bootstrap path is used on macOS, Linux, and Windows, with the
platform-specific JRE archive pinned in `versions.py`.

---

## Lazy routing sidecar

GraphHopper is run as a lazy sidecar on port `8002`.

- It starts on the first `POST /api/v1/maps/route` request for an
  installed region.
- It stays warm while route traffic continues.
- It shuts down after an idle window to avoid pinning routing RSS in
  memory when the user is not navigating.

This preserves the old lazy-router behavior while swapping the backend
runtime from Valhalla to GraphHopper.

---

## Troubleshooting

**Toolchain missing**
If the install stream ends with `error="toolchain_missing"`, re-run:

```bash
./run.sh --maps-tools-only
```

That restores the embedded JRE plus both maps JARs under
`.lokidoki/tools/`.

**Out of memory**
If `planetiler` or GraphHopper import is killed by the OS, lower the
Java heap and retry with a smaller region if needed:

```bash
export LOKIDOKI_PLANETILER_HEAP_MB=1536
export LOKIDOKI_GRAPHHOPPER_HEAP_MB=1024
```

If the region still OOMs on Pi 5, it is too large for local build on
that profile.

**Cancelled install**
Cancel removes the active `.tmp/` directory and any partial PMTiles or
routing output. Re-running Install starts from the next artifact that is
still missing.

**No routing after install**
Check that `data/maps/<region>/valhalla/graph-cache/` exists and that
bootstrap installed:

```bash
.lokidoki/tools/jre/bin/java -version
.lokidoki/tools/jre/bin/java -jar .lokidoki/tools/graphhopper/graphhopper.jar --help
```
