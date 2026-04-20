# Chunk 7 — Polygon-based world labels (no more "GHANISTAN", no missing Russia/Canada)

## Goal

After this chunk, the world-overview labels render as **polygons**
instead of fixed `Point` anchors. MapLibre's
`symbol-placement: "point"` on a polygon source recomputes the label
anchor as the pole-of-inaccessibility *of the visible portion* — so
when you pan into Siberia or Ontario, the country label re-anchors
inside the visible chunk instead of disappearing because Moscow /
Manitoba is off-screen. Same fix collapses the
"AFGHANISTAN" → "GHANISTAN" / "ISTAN" clipping seen at the viewport
edge.

The output GeoJSON keeps its current name (`world-labels.geojson`)
and stays under ~1.5 MB (admin_0_countries simplified + admin_1
states subset). Nothing else in the runtime changes — same source
id (`world_labels`), same layer ids
(`world_place_country`, `world_place_state`), same fontstack.

## Files

- `lokidoki/bootstrap/preflight/world_labels.py` — restructure
  `_country_features` and `_state_features` to emit Polygon /
  MultiPolygon features pulled from the NE sqlite's geometry
  columns (NE Spatialite ships geometry as WKB blobs in the
  `GEOMETRY` column). The `kind`, `name`, `min_zoom`, `max_zoom`
  properties are unchanged. Drop the `label_x` / `label_y` /
  `latitude` / `longitude` fields — symbol-placement-on-polygon
  derives the anchor.
- `frontend/src/pages/maps/style-dark.ts` — change the layer
  declarations:
  - Add `'symbol-placement': 'point'` to both `world_place_country`
    and `world_place_state` layout (default — but be explicit).
  - Add `'text-variable-anchor': ['center']` and
    `'text-justify': 'auto'` so re-anchored labels still center.
  - Keep the `maxzoom` removal from chunk 5.
- `lokidoki/bootstrap/versions.py` — bump
  `WORLD_LABELS_GEOJSON_MIN_BYTES` (or whatever sentinel the
  preflight uses to skip the rebuild) so the existing point-based
  GeoJSON gets regenerated. If no such sentinel exists, add a
  `WORLD_LABELS_VERSION = "polygon-1"` constant the preflight reads
  and stamps inside the GeoJSON top-level (e.g.
  `{"type": "FeatureCollection", "version": "polygon-1", "features": ...}`)
  and refuses to skip when the on-disk version differs.
- `tests/unit/bootstrap/test_preflight_world_labels.py` — extend:
  - Assert at least one feature has geometry type `Polygon` or
    `MultiPolygon` (not `Point`).
  - Assert no feature carries `latitude` / `longitude` / `label_x`
    / `label_y` properties anymore.
  - Assert the `name` property still resolves for a known country
    (e.g. `"Russia"`).
- `frontend/src/pages/maps/style-dark.test.ts` — assert both world
  label layers explicitly set `symbol-placement: 'point'`.

Read-only:
- Existing `lokidoki/bootstrap/preflight/world_labels.py` for the
  sqlite-extraction + atomic-write pattern.
- The Natural Earth dataset's `ne_10m_admin_0_countries` and
  `ne_10m_admin_1_states_provinces` schemas — `GEOMETRY` column
  shape needs to be confirmed in chunk execution (column is
  Spatialite WKB; use `shapely` if already available, otherwise
  decode WKB manually with `binascii` + a tiny WKB parser — but
  prefer using `shapely.wkb.loads` if `shapely` is in
  `pyproject.toml` already; if not, add it through `pyproject.toml`
  per the no-`uv add` rule).

## Actions

1. **Inspect the NE sqlite geometry column**:
   ```python
   conn.execute("PRAGMA table_info(ne_10m_admin_0_countries)")
   ```
   Confirm a `GEOMETRY` (or `geom`) column exists. Pick `shapely`
   for WKB decoding — it's the standard. If absent from
   `pyproject.toml`, add it (and let the bootstrap install).
2. **Replace `_country_features`** to build Polygon /
   MultiPolygon GeoJSON geometries from
   `shapely.wkb.loads(row["GEOMETRY"]).__geo_interface__`. Drop
   the `label_x`/`label_y`/`latitude`/`longitude` fields. Keep
   the `min_zoom` lifted from `_zoom_floor(row["min_label"], default=1)`
   and `max_zoom` defaulting to `22` (chunk 5 already lifted this).
3. **Replace `_state_features`** the same way.
4. **Bump the version sentinel.** If `_present_above` skip is
   purely byte-count, replace with a content-version check: parse
   the existing JSON's top-level `"version"` field; rebuild when
   absent or mismatched. Stamp `"version": "polygon-1"` into the
   new output.
5. **Style edits.** In `style-dark.ts`, on both world-place layers
   add `'symbol-placement': 'point'` and
   `'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right']`
   so MapLibre can re-anchor against the visible polygon area.
6. **Re-run bootstrap.** Delete the existing
   `.lokidoki/tools/planetiler/world-labels.geojson` and re-run
   `./run.sh --maps-tools-only`. Confirm in the browser that
   panning into Siberia shows `RUSSIA`, panning into Ontario
   shows `CANADA`, and panning to the Afghanistan / Pakistan
   border shows the full `AFGHANISTAN` text.

## Verify

```
uv run pytest tests/unit/bootstrap/test_preflight_world_labels.py -q \
  && (cd frontend && npx vitest run src/pages/maps/style-dark.test.ts) \
  && uv run python -c "import json; \
        from pathlib import Path; \
        p = Path('.lokidoki/tools/planetiler/world-labels.geojson'); \
        gj = json.loads(p.read_text()); \
        kinds = {f['geometry']['type'] for f in gj['features']}; \
        assert {'Polygon','MultiPolygon'} & kinds, kinds; \
        assert all('label_x' not in f['properties'] for f in gj['features']); \
        names = {f['properties']['name'] for f in gj['features']}; \
        assert 'Russia' in names, sorted(names)[:20]; \
        print('OK polygon labels:', len(gj['features']), 'features,', kinds)"
```

## Commit message

```
fix(maps): switch world labels from point anchors to polygon geometry

The previous static world-labels.geojson emitted one Point per
country/state at NE's label_x/label_y. When the user panned away
from that anchor, large countries (Russia, Canada, USA) lost their
label entirely, and labels near the viewport edge truncated to
"GHANISTAN" / "ISTAN" because the text origin was just off-screen.

Now each feature is a Polygon / MultiPolygon decoded from the NE
sqlite GEOMETRY column. MapLibre's symbol-placement: "point" on a
polygon source computes the pole-of-inaccessibility of the
*visible* portion, so the label re-anchors inside whatever chunk
of the country is on-screen. Versioned GeoJSON output forces the
preflight to rebuild when the schema changes.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 7.
```

## Deferrals

(Empty.)
