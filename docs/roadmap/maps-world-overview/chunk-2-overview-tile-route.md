# Chunk 2 — Backend: serve `world-overview.pmtiles`

## Goal

After this chunk, the FastAPI app serves the world-overview pmtiles
built by chunk 1 at
`GET /api/v1/maps/tiles/_overview/streets.pmtiles`. The handler is a
sibling of the existing per-region tile route — same `FileResponse`
shape, same cache headers, same `Accept-Ranges: bytes` support so
MapLibre's pmtiles protocol can issue Range requests for the
directory + individual tile blobs.

The route is intentionally defined as a separate handler — not a
parameterised reuse of
`get_streets_pmtiles(region_id)` — because:

1. The source file lives under `.lokidoki/tools/planetiler/`, not
   `data/maps/<region_id>/` (it is a bootstrap artifact, not a
   per-region install artifact).
2. `_validate_region_id` rejects underscore-prefixed IDs by design,
   so even if we tried `region_id="_overview"` the existing handler
   would 400 the request.

Prereq: chunk 1 done (file must exist on disk for the handler to
serve it). When the file is missing the handler returns 404 with a
message pointing the user at `--maps-tools-only`, matching the
existing error shape.

## Files

- `lokidoki/api/routes/maps.py` — add a new handler next to
  `get_streets_pmtiles`:
  ```python
  @router.get("/tiles/_overview/streets.pmtiles")
  async def get_overview_pmtiles():
      """Serve the global z0–z7 overview basemap built by bootstrap.

      Sits next to every region's own streets.pmtiles; the frontend
      style wires both sources — this one paints country/state
      polygons + labels at low zoom, the per-region one paints
      everything else at higher zoom.
      """
      path = _overview_pmtiles_path()
      if not path.is_file():
          raise HTTPException(
              404,
              "world-overview.pmtiles not built — run ./run.sh --maps-tools-only",
          )
      return FileResponse(
          path,
          media_type="application/octet-stream",
          headers={
              "Accept-Ranges": "bytes",
              "Cache-Control": _TILE_CACHE_CONTROL,
          },
      )
  ```
  - Add a module-level helper `_overview_pmtiles_path()` that returns
    `Path(".lokidoki/tools/planetiler/world-overview.pmtiles")`. Keep
    it a plain function (no import of bootstrap context — the app
    process doesn't carry a `StepContext`).
- `tests/unit/test_maps_tile_route.py` — extend the existing tile
  route tests. Add three cases:
  - **404 when file missing** — tmp data dir with nothing in
    `tools/planetiler/`. Expect `{"detail": "... --maps-tools-only"}`
    response body.
  - **200 + content when file present** — write a small fixture byte
    blob to the path; assert `Accept-Ranges: bytes`, correct
    media type, response content matches fixture.
  - **Range request served** — issue `Range: bytes=0-15`; expect
    `206 Partial Content` and the first 16 bytes. (Starlette's
    `FileResponse` does this for free; test guards the regression.)
  - Reuse the existing test harness — look at how the per-region
    route tests set up the tmp `data/maps/<id>/streets.pmtiles`
    fixture and mirror that, but under
    `.lokidoki/tools/planetiler/world-overview.pmtiles`.

Read-only for reference:
- [lokidoki/api/routes/maps.py::get_streets_pmtiles](../../../lokidoki/api/routes/maps.py)
  — the exact shape to mirror.
- [tests/unit/test_maps_tile_route.py](../../../tests/unit/test_maps_tile_route.py)
  — existing tile-route tests (fixture style + how `Range` is
  exercised).

## Actions

1. Add `_overview_pmtiles_path()` helper + `get_overview_pmtiles()`
   handler to `lokidoki/api/routes/maps.py`. Place the handler
   immediately after `get_streets_pmtiles` so the two tile routes
   stay visually adjacent.
2. Add the three new test cases to
   `tests/unit/test_maps_tile_route.py`. Prefer extending existing
   fixtures over duplicating them.
3. Confirm no other route in `maps.py` handles the literal path
   `/tiles/_overview/streets.pmtiles` (route precedence would
   otherwise matter — FastAPI matches longest specific path, but
   verify there's no regression in the per-region handler).

## Verify

```bash
uv run pytest tests/unit/test_maps_tile_route.py -x -q

# Live smoke (requires chunk 1 to have produced the file):
# curl -sI http://127.0.0.1:8000/api/v1/maps/tiles/_overview/streets.pmtiles \
#   | grep -E '^(HTTP|Accept-Ranges|Content-Length)'
# expect:
#   HTTP/1.1 200 OK
#   Accept-Ranges: bytes
#   Content-Length: <≥ 5 MB>
```

## Commit message

```
feat(maps): serve world-overview.pmtiles over /tiles/_overview/

New GET /api/v1/maps/tiles/_overview/streets.pmtiles handler serves
the bootstrap-built global overview basemap via FileResponse with
Range support. Handler is a sibling of get_streets_pmtiles — shares
cache headers and media type, but reads from
`.lokidoki/tools/planetiler/` (a bootstrap artifact path) rather
than `data/maps/<region>/`.

Sets up chunk 3 (frontend dual-source style) by providing the second
tile URL MapLibre will reference.

Refs docs/roadmap/maps-world-overview/PLAN.md chunk 2.
```

## Deferrals section (append as you discover)

*(empty — leave for chunk-2 execution to fill)*
