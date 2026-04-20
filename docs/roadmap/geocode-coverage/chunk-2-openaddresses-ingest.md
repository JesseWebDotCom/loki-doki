# Chunk 2 — Ingest OpenAddresses CSV into the FTS5 index

## Goal

After this chunk, the per-region geocoder index also contains every
parcel-level address from the OpenAddresses ZIP that chunk 1 lands
on disk. The schema is unchanged — OA rows reuse the existing
`places` virtual table with `class="address"` — so search and the API
shape stay backward-compatible. Re-running install for `us-ct` (with
the OA file present) produces a `geocoder.sqlite` that returns
*"500 Nyala Farms Road, Westport"* for the original failing query.

OA + OSM rows for the same parcel are deduped at search time
(chunk 4), not at ingest — keeping ingest pure-append makes
re-running cheap and isolates the schema-touch work.

## Files

- `lokidoki/maps/geocode/oa_ingest.py` — new. Public entry point
  `ingest_openaddresses(zip_path, output_db, region_id, progress_cb=None)
  -> IngestStats`. Reads the ZIP without extracting to disk
  (`zipfile.ZipFile.open` on the inner CSV stream), `csv.DictReader`
  per row, batches into the same `places` table the OSM indexer
  writes to. Each row maps:
  - `housenumber = NUMBER`
  - `street = STREET` (title-cased — OA is uppercase by convention)
  - `city = CITY`
  - `postcode = POSTCODE`
  - `admin1 = REGION`
  - `name = f"{NUMBER} {STREET}".strip()`
  - `lat, lon = LAT, LON`
  - `class = "address"`
  - `osm_id = f"oa:{HASH}"` (OA's per-row stable hash; falls back to
    `f"oa:{region_id}:{seq}"` if absent).
- `lokidoki/maps/geocode/fts_index.py` — small extension only:
  expose the `_open_db()`, `_flush()`, and `_Row` dataclass via
  `__all__` so `oa_ingest.py` reuses them. **Do not** duplicate the
  schema string — import `_CREATE_SCHEMA` from `fts_index`.
- `lokidoki/maps/store.py` — extend `_build_geocoder_step` to chain
  `ingest_openaddresses` immediately after `build_index` when the
  OA archive is present. Emit a new SSE phase
  `"building_geocoder_oa"` so the admin panel can show "indexing
  parcel data". Add the OA row count into
  `state.bytes_on_disk["geocoder"]` indirectly (re-`stat()` after
  ingest).
- `tests/unit/test_geocode_oa_ingest.py` — new. Build a tiny CSV with
  3 rows (one being a "500 Nyala Farms Road" lookalike), zip it,
  run `ingest_openaddresses` against an empty FTS DB, then run the
  existing `fts_search.search()` and assert the lookalike row comes
  back at rank 0.

Read-only references:
- `lokidoki/maps/geocode/fts_index.py` — schema + `_Row` shape +
  batch-flush pattern.
- OpenAddresses [output schema](https://github.com/openaddresses/openaddresses/blob/master/CONTRIBUTING.md#output)
  — confirms CSV column order: `LON,LAT,NUMBER,STREET,UNIT,CITY,
  DISTRICT,REGION,POSTCODE,ID,HASH`.

## Actions

1. **Reuse the existing schema.** Refactor `fts_index.py` so
   `_CREATE_SCHEMA`, `_open_db`, `_flush`, `_Row` are exported (no
   leading underscore on the re-exports OR explicit `__all__`
   addition with the underscored names). Zero behavior change for
   OSM ingest.
2. **Implement OA ingest.** Streaming reader — never load the full
   CSV into RAM. Batch size 5000 rows (FTS5 likes larger batches
   than the OSM streamer because rows are uniform-shaped and cheap
   to construct). Skip rows with empty `STREET` or non-numeric
   `LAT`/`LON`. Title-case the street with `.title()` and squash
   double whitespace.
3. **Hook into the install pipeline.** In `_build_geocoder_step`,
   after `build_index` returns successfully:
   ```python
   oa_zip = region_dir(region_id) / "openaddresses.zip"
   if oa_zip.exists():
       await emit(MapInstallProgress(
           region_id=region_id, artifact="geocoder",
           bytes_done=0, bytes_total=0,
           phase="building_geocoder_oa",
       ))
       def _run_oa() -> int:
           stats = ingest_openaddresses(oa_zip, db_path, region_id)
           return stats.rows
       oa_rows = await loop.run_in_executor(None, _run_oa)
   ```
   Emit a final `phase="ready"` event afterward as today.
4. **Tests.**
   - `test_geocode_oa_ingest.py`: build 3-row CSV
     `[500,"Nyala Farms Road","Westport","CT","06880",lat,lon]`
     (plus two distractors), ingest into a fresh DB at
     `tmp_path/data/maps/us-ct/geocoder.sqlite`, then call
     `fts_search.search("500 nyala farms", viewport, ["us-ct"],
     data_root=tmp_path)`. Assert top hit `housenumber=="500"` and
     `street.lower()=="nyala farms road"`.
5. **Run the existing FTS test suite** (`tests/unit/test_geocode_*`)
   to confirm no regressions in OSM-only ingest behavior.

## Verify

```
uv run pytest tests/unit/test_geocode_oa_ingest.py \
              tests/unit/test_geocode_fts_build.py \
              tests/unit/test_geocode_fts_search.py \
              tests/unit/test_geocode_api.py -q \
  && uv run python -c "from lokidoki.maps.geocode import oa_ingest; \
        import inspect; \
        sig = inspect.signature(oa_ingest.ingest_openaddresses); \
        assert {'zip_path','output_db','region_id'} <= set(sig.parameters), sig.parameters; \
        print('OK', list(sig.parameters))"
```

## Commit message

```
feat(maps): ingest OpenAddresses parcel CSVs into the FTS geocoder

Streams the OpenAddresses statewide ZIP that chunk 1 staged for each
US region into the existing FTS5 places table. With us-ct re-indexed,
"500 Nyala Farms Road" now returns the correct parcel — the same
parcel-level coverage Pelias / Geocode Earth get from OA. Schema
unchanged; OA rows carry osm_id="oa:<hash>" so downstream dedup can
distinguish them.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 2.
```

## Deferrals

(Empty.)
