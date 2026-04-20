# Chunk 13 — Install Noto Sans Bold + Noto Sans Italic glyph stacks

## Goal

After this chunk, `GET /api/v1/maps/glyphs/Noto%20Sans%20Bold/0-255.pbf`
and `GET /api/v1/maps/glyphs/Noto%20Sans%20Italic/0-255.pbf` both return
200 with the PBF bytes the basemaps-assets tarball already ships inside
itself, and chunk 9's shield labels (`'text-font': ['Noto Sans Bold']`)
and `waterway_label` italic labels (`'text-font': ['Noto Sans Italic']`)
render with the right weight/style instead of MapLibre's per-codepoint
local fallback glyphs. Today the browser spams ~60
`Rendering codepoint U+XXXX locally instead` warnings per page-load
because the preflight extracts only one fontstack.

The basemaps-assets release already contains the Bold + Italic PBFs —
this chunk widens the preflight's extraction filter; no new download,
no new pin, no new SHA.

## Files

- `lokidoki/bootstrap/preflight/glyphs.py` — widen extraction:
  - Replace the module-level `_FONTSTACK = "Noto Sans Regular"`
    constant at [glyphs.py:23](../../../lokidoki/bootstrap/preflight/glyphs.py#L23)
    with a `_FONTSTACKS: tuple[str, ...] = ("Noto Sans Regular",
    "Noto Sans Bold", "Noto Sans Italic")` tuple.
  - Update `ensure_glyphs` at
    [glyphs.py:26](../../../lokidoki/bootstrap/preflight/glyphs.py#L26):
    the `first_pbf` existence probe must check every fontstack's
    `0-255.pbf`; `_extract_glyphs` must loop the tuple and write
    each stack into its own `<target>/<fontstack>/` directory.
  - Keep the "extraction found zero PBFs" and "first PBF missing
    or empty" raises — extend them to name which fontstack failed
    so a future upstream repack (Bold dropped from the tarball)
    fails loudly instead of silently.
- `tests/unit/test_glyphs_preflight.py` — **new**. Two tests using
  a hand-authored gzipped tarball fixture with three
  `fonts/<stack>/0-255.pbf` members:
  - `test_extracts_all_three_fontstacks` — asserts all three
    target directories exist and each contains `0-255.pbf`.
  - `test_raises_when_required_stack_missing_from_archive` —
    builds a tarball without Italic, asserts `RuntimeError`
    naming the missing stack.
- `scripts/build_offline_bundle.py` — read-only verify: the
  existing `basemaps-assets` entry in the bundle manifest already
  carries the tarball we need, no pin change required. If a quick
  `grep basemaps-assets scripts/build_offline_bundle.py` comes back
  empty, add the entry (sha256 + filename matching
  `lokidoki/bootstrap/versions.py::GLYPHS_ASSETS`).

Read-only:
- `lokidoki/bootstrap/versions.py::GLYPHS_ASSETS` — the pin that
  identifies the tarball. Do not change the commit SHA or URL.
- `lokidoki/api/routes/maps.py:321` — the glyph route reads files
  from `_glyphs_dir() / fontstack / f"{range_stem}.pbf"`; this
  chunk's filesystem layout must match.

## Actions

1. **Edit `ensure_glyphs` + `_extract_glyphs`** to loop the
   `_FONTSTACKS` tuple. Per-stack `needle = f"fonts/{stack}/"`
   and per-stack `dest = target / stack`. Accumulate `count` across
   all stacks; raise if any stack's `0-255.pbf` is missing after
   extraction.
2. **Preserve the "already present" short-circuit** — check that
   EVERY stack's `0-255.pbf` exists + is non-empty before
   short-circuiting; otherwise a partial prior install keeps
   returning "already present" forever.
3. **Tests** as listed. Build the fixture tarball inline in the
   test with `tarfile.open(..., "w:gz")` — small enough that
   dedicated fixtures are overkill.
4. **Manual verification.** Blow away `.lokidoki/tools/glyphs/`,
   re-run `./run.sh`, then curl:
   ```
   curl -sI "http://127.0.0.1:8000/api/v1/maps/glyphs/Noto%20Sans%20Bold/0-255.pbf" | head -1
   curl -sI "http://127.0.0.1:8000/api/v1/maps/glyphs/Noto%20Sans%20Italic/0-255.pbf" | head -1
   ```
   Both should print `HTTP/1.1 200 OK`.

## Verify

```
uv run pytest tests/unit/test_glyphs_preflight.py -q \
  && python3 -c "from lokidoki.bootstrap.preflight.glyphs import _FONTSTACKS; \
        assert set(_FONTSTACKS) == {'Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'}, _FONTSTACKS; \
        print('OK fontstacks:', _FONTSTACKS)"
```

## Commit message

```
feat(bootstrap): install Noto Sans Bold + Italic glyph stacks

Chunk 9 added text-font: ['Noto Sans Bold'] for route shield labels
and ['Noto Sans Italic'] for waterway_label; the preflight only
extracted Noto Sans Regular from the basemaps-assets tarball, so
both routes 404'd and MapLibre fell back to per-codepoint local
glyphs (the ~60 'Rendering codepoint U+XXXX locally instead' lines
in the browser console).

Widen ensure_glyphs to extract all three stacks from the same pinned
tarball. No new download, no pin change -- the tarball already ships
Bold and Italic, we were just throwing them away.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 13.
```

## Deferrals

(Empty.)
