# Chunk 1 — Local glyph PBFs + FastAPI route + style swap

## Goal

After this chunk, the MapLibre style loads text glyphs from a local
FastAPI route served off disk — not
`protomaps.github.io/basemaps-assets/fonts/...`. A new
`install-glyphs` preflight downloads the pinned basemaps-assets
release tarball, extracts the `Noto Sans Regular/*.pbf` glyph range
files into `data/tools/glyphs/Noto Sans Regular/`, and the FastAPI
route at `GET /api/v1/maps/glyphs/{fontstack}/{range}.pbf` sendfiles
the matching file. The style's `glyphs:` URL points at that route,
and grep-auditing the frontend for `protomaps.github.io` returns zero
matches.

Prereqs: none beyond the current main.

## Files

- `lokidoki/bootstrap/versions.py` — add `GLYPHS_ASSETS` spec. Single
  tarball, so no per-`(os, arch)` matrix:
  ```python
  GLYPHS_ASSETS = {
      "version": "<pinned basemaps-assets tag>",
      "filename": "basemaps-assets-<version>.tar.gz",
      "sha256": "<sha256>",
      "url_template": (
          "https://github.com/protomaps/basemaps-assets/archive/"
          "refs/tags/v{version}.tar.gz"
      ),
  }
  ```
  Pin the tag against whatever the latest stable release is at
  chunk-1 execution time (mirror llama.cpp pattern — pin a GH release
  asset URL, not a mutable `latest`).
- `lokidoki/bootstrap/preflight/glyphs.py` — new. Downloads the
  tarball, verifies sha256, extracts the `fonts/Noto Sans Regular/`
  subtree into `data/tools/glyphs/Noto Sans Regular/`. Discards the
  rest of the archive (the repo also ships sprites, icons, etc. we
  don't use). Smoke test: assert `0-255.pbf` exists and is non-empty
  after extraction. Register `"glyphs"` in `ctx.tools` so
  `ctx.binary_path("glyphs")` resolves to the base dir.
- `lokidoki/bootstrap/context.py` — add `"glyphs"` to `_LAYOUT` as
  `{"unix": "glyphs", "win": "glyphs"}` (dir, not file; resolver
  handles both).
- `lokidoki/bootstrap/steps.py` — register `install-glyphs` in
  `_REAL_RUNNERS` / `_STEP_CATEGORY` (category `"system"`). Add to
  `_PRE_MAPS_STACK` alongside the JRE + planetiler + GraphHopper
  preflights. Ordering: after `install-jre`, before
  `install-planetiler` (unrelated but keeps maps preflights
  contiguous).
- `lokidoki/api/routes/maps.py` — new route
  `GET /tiles/glyphs/{fontstack}/{range}.pbf` (mounted under
  `/api/v1/maps` via the existing router) that sendfiles from
  `data/tools/glyphs/{fontstack}/{range}.pbf`. Validate fontstack +
  range against a narrow regex (`^[A-Za-z0-9 ]+$` and `^\d+-\d+$`)
  to prevent directory traversal. Follow the shape of
  `get_streets_pmtiles` — `FileResponse`, byte-range OK but not
  required for glyph files.
- `frontend/src/pages/maps/style-dark.ts` — replace the literal
  `glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf'`
  with `glyphs: '/api/v1/maps/glyphs/{fontstack}/{range}.pbf'`.
- `scripts/build_offline_bundle.py` — add `GLYPHS_ASSETS` to the
  download manifest so air-gapped installs stage it.
- `tests/unit/bootstrap/test_preflight_glyphs.py` — new. Mock the
  download with a small tar fixture, assert the glyphs dir lands
  with at least one `.pbf` file, assert sha256 verification fires.
- `tests/unit/bootstrap/test_versions.py` — add `GLYPHS_ASSETS`
  assertions (URL shape, sha256 length).
- `tests/unit/test_maps_glyphs_route.py` — new. FastAPI TestClient
  against an isolated data dir; lay down a fake PBF; assert
  `GET /api/v1/maps/glyphs/Noto%20Sans%20Regular/0-255.pbf` returns
  200 + the file bytes; assert traversal attempts (`..`, absolute
  paths, weird fontstack names) return 400.

Read-only for reference:
[lokidoki/bootstrap/preflight/planetiler.py](../../../lokidoki/bootstrap/preflight/planetiler.py)
(closest existing shape — single tarball, sha verify, no PATH patch),
[lokidoki/api/routes/maps.py::get_streets_pmtiles](../../../lokidoki/api/routes/maps.py)
(sendfile pattern to mirror).

## Actions

1. Find the latest stable tag on
   `protomaps/basemaps-assets` (GitHub releases). Pull the tarball
   locally once, capture its sha256 with `shasum -a 256`. Verify the
   archive contains `fonts/Noto Sans Regular/{0-255,256-511,...}.pbf`.
   If the ranges you need are missing, stop and write a `## Blocker`
   — don't guess glyph coverage.
2. Write `preflight/glyphs.py` mirroring
   `preflight/planetiler.py`. Download, sha verify, extract ONLY the
   `fonts/Noto Sans Regular/` subtree to
   `data/tools/glyphs/Noto Sans Regular/`. Log the extracted file
   count.
3. Wire `install-glyphs` into the step pipeline. Keep
   `_MAPS_ENABLED_PROFILES` as-is.
4. Add the FastAPI route. Use `FileResponse` + `media_type="application/x-protobuf"`.
   Validate the path components with a regex before building the
   filesystem path. Return 404 when the file is absent (not 500), 400
   when inputs fail validation.
5. Update `style-dark.ts` to the local URL. Path is absolute so it
   works regardless of where the bundle is served from.
6. Update `scripts/build_offline_bundle.py`.
7. Tests:
   - Preflight test with a tarball fixture built in-process.
   - `test_versions.py` — shape assertions.
   - `test_maps_glyphs_route.py` — happy path + 3 traversal cases.

## Verify

```bash
uv run pytest tests/unit/bootstrap/test_preflight_glyphs.py \
              tests/unit/bootstrap/test_versions.py \
              tests/unit/test_maps_glyphs_route.py -x -q

# End-to-end (mac only):
rm -rf .lokidoki/tools/glyphs
./run.sh --maps-tools-only
ls "data/tools/glyphs/Noto Sans Regular" | head -5
# Should list range PBFs.

# Grep audit — MUST return zero matches after this chunk:
rg "protomaps.github.io" frontend/src lokidoki || echo "OK: no CDN refs"
```

Manually: open `/maps`, load CT, zoom to z14, confirm street names /
POI labels render with no network (disable Wi-Fi first — Chrome
DevTools' "Offline" throttle is NOT enough, it still hits disk cache
from the CDN).

## Commit message

```
feat(maps): serve glyph PBFs locally, drop protomaps.github.io CDN

New install-glyphs preflight pulls the pinned basemaps-assets release
tarball, extracts the Noto Sans Regular range PBFs under
data/tools/glyphs/, and a FastAPI /api/v1/maps/glyphs/... sendfile
route serves them. The MapLibre style now references the local URL
and the Protomaps GH Pages CDN is no longer consulted at runtime.

Closes the first of two remaining runtime CDN holes flagged in the
offline-first invariant.

Refs docs/roadmap/maps-offline-hardening/PLAN.md chunk 1.
```

## Deferrals section (append as you discover)

*(empty — leave for chunk-1 execution to fill)*
