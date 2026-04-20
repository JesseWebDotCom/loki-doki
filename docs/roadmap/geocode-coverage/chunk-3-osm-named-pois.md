# Chunk 3 — Index named OSM POIs and buildings

## Goal

After this chunk, the FTS geocoder also returns named OSM features —
*"Bridgewater Associates"*, *"Yale University"*, *"Sherwood Diner"* —
not just addresses. The OSM streamer in `fts_index.py` learns to emit
a row for any node, way, or area that carries `name=*` AND a key in a
curated POI keyset, regardless of whether it has an address.

The class column gains values like `poi:office`, `poi:amenity`,
`poi:shop`, `poi:tourism`, `poi:leisure`, `poi:healthcare`,
`poi:building` so callers can later distinguish them in the UI
(rendered as a small chip — "Office", "School", etc.). Search itself
treats them like any other row.

## Files

- `lokidoki/maps/geocode/fts_index.py` — extend with a new helper
  `_poi_row(osm_id, tags, lat, lon)` that returns a `_Row` with
  `class="poi:<key>"` when `tags` contains `name` plus one of the
  POI keys. Wire it into the streamer **after** the address /
  settlement / postcode checks (so a feature with both an address
  and a name still gets address-classed — the POI row would be a
  duplicate at the same coords).
- `lokidoki/maps/store.py` — preserve the source PBF through the
  geocoder build phase. Today `_build_geocoder_step` runs after
  download and assumes the PBF stays on disk; confirm the PBF
  cleanup at the end of `install_region` runs *after* both
  `_build_geocoder_step` and the new chunk-2 OA ingest. (No code
  change expected; this is a verification step. If broken, fix.)
- `tests/unit/test_geocode_poi_index.py` — new. Synthesize a tiny
  PBF (using the existing `osmium.SimpleWriter` pattern from
  `test_geocode_fts_search.py`) with one named office, one
  unaddressed amenity, one named-but-no-key way, and one tagged
  address. Run `build_index`, then assert:
  - The office and the amenity are in the DB with `class LIKE
    'poi:%'`.
  - The unaddressed-keyless feature is NOT in the DB.
  - The tagged address still gets `class="address"` (POI shadow row
    is suppressed when an address row already exists at the same
    coords + osm_id).

Read-only:
- `lokidoki/maps/geocode/fts_index.py` — entire file. Pattern for
  `_address_row`, `_settlement_row`, `_postcode_row` informs the
  POI helper shape and ordering.

## Actions

1. **Define the POI keyset.** Top of `fts_index.py`, alongside
   `_SETTLEMENT_PLACES`:
   ```python
   # Top-level OSM keys whose presence + a `name` tag makes a feature
   # worth surfacing in the geocoder. Order matters only for the
   # ``class="poi:<key>"`` column we write — the row is identical
   # otherwise.
   _POI_KEYS = (
       "amenity",
       "office",
       "shop",
       "tourism",
       "leisure",
       "healthcare",
       "craft",
       "building",   # last — only fires when no other POI key matches
   )
   ```
2. **Implement `_poi_row`.** Pseudocode:
   ```python
   def _poi_row(osm_id, tags, lat, lon):
       name = (tags.get("name") or "").strip()
       if not name:
           return None
       for key in _POI_KEYS:
           val = tags.get(key)
           if not val or val == "no":
               continue
           # `building` fires for any value, including yes — but only
           # when no specialized key already matched. Skip residential
           # and apartment buildings to avoid swamping the index.
           if key == "building" and val in {"yes", "house",
                                            "residential", "apartments",
                                            "garage", "shed"}:
               continue
           street = (tags.get("addr:street") or "").strip()
           house = (tags.get("addr:housenumber") or "").strip()
           city = (tags.get("addr:city") or "").strip()
           postcode = (tags.get("addr:postcode") or "").strip()
           return _Row(
               osm_id=osm_id, name=name,
               housenumber=house, street=street, city=city,
               postcode=postcode, admin1="",
               lat=lat, lon=lon, klass=f"poi:{key}",
           )
       return None
   ```
3. **Wire into the streamer.** In `build_index`, after the existing
   address/settlement/postcode cascade, add a fourth fallback:
   ```python
   else:
       row = _poi_row(osm_id, tags, lat, lon)
       if row is not None:
           batch.append(row)
           stats.pois += 1
   ```
   Add `pois: int = 0` to the `IndexStats` dataclass and roll it
   into `total`. Bump `row_counts()` to also count `poi:%` classes.
4. **Suppress duplicate POI shadow.** When the address branch fires
   for a feature that ALSO has a name + POI key, the POI row would
   land at the same coords with the same `osm_id`. Solution: the
   `else` cascade above already suppresses this — addresses win.
   Verify with the test below.
5. **Tests.** Cover the four cases listed in `## Files`. Use
   `osmium.SimpleWriter` from `tests/unit/test_geocode_fts_search.py`.

## Verify

```
uv run pytest tests/unit/test_geocode_poi_index.py \
              tests/unit/test_geocode_fts_build.py \
              tests/unit/test_geocode_fts_search.py -q \
  && uv run python -c "from lokidoki.maps.geocode.fts_index import IndexStats, _POI_KEYS; \
        s = IndexStats(); \
        assert hasattr(s, 'pois') and s.total == 0; \
        assert 'office' in _POI_KEYS and 'building' in _POI_KEYS; \
        print('OK pois field present, POI keyset wired')"
```

## Commit message

```
feat(maps): index named OSM POIs and buildings into the FTS geocoder

Extends the PBF streamer in fts_index.py to emit a row for any node /
way carrying `name` plus one of {amenity, office, shop, tourism,
leisure, healthcare, craft, building}. With us-ct rebuilt,
"Bridgewater Associates" now returns the office's centroid in
Westport. Address rows still take precedence — POI shadow rows are
suppressed when the same feature has an addr:housenumber.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 3.
```

## Deferrals

(Empty.)
