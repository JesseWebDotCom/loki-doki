# Self-hosting the offline-maps artifact bucket

LokiDoki's region installer (Settings → Maps) downloads three artifact
types per region:

- `streets.pmtiles` — vector basemap (rendered by MapLibre)
- `satellite.tar.zst` — optional raster imagery (off by default)
- `valhalla.tar.zst` — prebuilt routing tiles (mmap-served by Valhalla)

By default, URLs point at `https://dist.lokidoki.app/maps/<region_id>/…`
— a placeholder host. While that host is offline, **pointing
`LOKIDOKI_MAPS_DIST_BASE` at your own bucket is the supported path**.
Set the env var before starting the app:

```bash
export LOKIDOKI_MAPS_DIST_BASE=http://localhost:9000/maps
./run.sh
```

Reload the Maps admin page — the orange banner disappears, and
installing `us-ct` (for example) fetches from
`http://localhost:9000/maps/us-ct/streets.pmtiles`.

## Artifact layout

Whatever host you stand up must serve this exact tree:

```
<dist-base>/
  <region_id>/
    streets.pmtiles
    satellite.tar.zst        (optional)
    valhalla.tar.zst
```

That's it. No index, no manifest — the server just needs to return the
three files with correct byte ranges (PMTiles requires `Range` support;
any static file server (`nginx`, `caddy`, `python -m http.server`)
handles that out of the box).

## Producing the artifacts

### Prerequisites

- `tippecanoe` — [github.com/felt/tippecanoe](https://github.com/felt/tippecanoe)
- `valhalla_build_tiles` — from the `valhalla` package
  ([valhalla/valhalla](https://github.com/valhalla/valhalla))
- `zstd` — for the `.tar.zst` Valhalla bundle
- a beefy host: country-scale Valhalla builds need 8–16 GB RAM; don't
  try this on the Pi itself

### One region at a time

```bash
REGION=us-ct
PBF_URL=$(python3 -c "from lokidoki.maps.catalog import get_region; \
                       print(get_region('${REGION}').pbf_url_template)")
OUT=./lokidoki-offline-bundle/maps/${REGION}
mkdir -p "${OUT}"

# 1. Geofabrik .osm.pbf
curl -L "${PBF_URL}" -o "${OUT}/source.osm.pbf"

# 2. PMTiles vector basemap
tippecanoe -o "${OUT}/streets.pmtiles" -z14 \
    --drop-densest-as-needed --force "${OUT}/source.osm.pbf"

# 3. Valhalla routing tiles -> tar.zst
VALHALLA_TMP=$(mktemp -d)
valhalla_build_tiles -c valhalla.json "${OUT}/source.osm.pbf" \
    --tile-dir "${VALHALLA_TMP}/tiles"
tar -C "${VALHALLA_TMP}" -cf - tiles \
    | zstd -19 -o "${OUT}/valhalla.tar.zst"
rm -rf "${VALHALLA_TMP}"
```

`scripts/build_offline_bundle.py --maps us-ct` prints the commands for
a given region and verifies the tool chain is present — it does not
execute the build (the pipeline is per-operator because input sizes
and tippecanoe flags vary).

### Satellite imagery (opt-in)

Satellite bundles are 10–20× larger than PMTiles. Source your own
(Esri World Imagery terms permit some use cases; verify licensing) or
skip the tab — the UI gates satellite behind an explicit checkbox.

## Serving the bucket

Any static file server works. A minimum viable one-liner:

```bash
cd ./lokidoki-offline-bundle/maps
python3 -m http.server 9000
```

For production, front with nginx / caddy + HTTPS + cache-control. The
app treats these URLs as long-lived immutable content — the browser
caches `.pmtiles` aggressively via byte-range fetches.

## Troubleshooting

**"Nothing happens" when clicking Install**  
The bundle host 404s or DNS-fails. With the fix in sub-chunk 8a, the
admin surfaces a red banner per-region with the HTTP status. Confirm
`curl -I "${LOKIDOKI_MAPS_DIST_BASE}/us-ct/streets.pmtiles"` returns
`200 OK` and `Accept-Ranges: bytes`.

**PMTiles render empty tiles**  
`tippecanoe` dropped too much at high zooms — re-run with
`--maximum-zoom=15` or drop `--drop-densest-as-needed`.

**Valhalla routing falls back to OSRM**  
Either the `.tar.zst` extraction left nothing under
`data/maps/<region>/valhalla/` (check the install log), or the tile
set was built from a different `.osm.pbf` than the active region
claims. Rebuild from the same Geofabrik URL the catalog points at.
