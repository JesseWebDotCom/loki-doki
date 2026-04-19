# Maps Offline Hardening — Execution Plan

Goal: close the remaining runtime CDN holes in the Maps stack so
LokiDoki honors the offline-first invariant (`docs/spec.md`: "bootstrap
is the only network boundary"). Today two upstream fetches still
happen at runtime or build time and violate the rule:

1. **Glyph PBFs** — the MapLibre style references
   `https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf`
   for text rendering. With the network unplugged, every place label,
   street name, and POI caption silently fails to glyph. The rest of
   the map (geometry, fills) still paints, which is why the hole is
   easy to miss in casual testing.
2. **planetiler `--download`** — the region-install pipeline invokes
   `java -jar planetiler.jar … --download`. That flag tells planetiler
   to fetch Natural Earth, water polygons, and (if no `--osm-path`)
   OSM itself from upstream CDNs at build time. `building_streets`
   therefore needs internet during install — not just the pinned
   Geofabrik PBF we already pre-download. On an air-gapped Pi the
   build hangs or errors.

Both are pre-download problems, same shape as every other runtime
binary LokiDoki already vendors through the bootstrap pipeline — just
data instead of code. This plan bolts two preflights onto
`lokidoki/bootstrap/` that materialize the upstream artifacts at
install time and point planetiler / the style at the local copies.

This plan supersedes the "Still deferred" bullets in
`docs/roadmap/maps-java-stack/PLAN.md` for glyphs and planetiler
`--download`. (The third deferred bullet — the Protomaps CDN demo
fallback in `tile-source.ts` — is fixed inline as part of the same
PR that introduces this plan.)

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

| # | Chunk                                                                           | Status  | Commit |
|---|---------------------------------------------------------------------------------|---------|--------|
| 1 | [Local glyph PBFs + FastAPI route + style swap](chunk-1-glyphs.md)              | done    | a00809e |
| 2 | [planetiler offline data sources + drop --download](chunk-2-planetiler-data.md) | done    | adc3c95 |

---

## Global context (read once, applies to every chunk)

### Offline invariant (from CLAUDE.md)

> **Offline-first at runtime — bootstrap is the only network boundary.**
> After `./run.sh` finishes, LokiDoki MUST run with the network cable
> unplugged. No CDN script tags, no CDN stylesheets, no remote
> web-font imports, no remote map-tile servers, no remote model APIs.
> Every asset the running app reaches for — JS, CSS, fonts, icons,
> map tiles, routing graphs, model weights — must resolve to a file
> bootstrap already placed on disk.

Both chunks reinforce this invariant. The measurable success
criterion per chunk: grep the tree for the upstream CDN host after
the chunk lands and confirm zero runtime references.

### Bootstrap integration pattern (mirror existing preflights)

The Temurin JRE / planetiler / GraphHopper preflights in
[lokidoki/bootstrap/preflight/](../../../lokidoki/bootstrap/preflight/)
already capture the shape we want. Per chunk:

1. Add a pinned entry to [versions.py](../../../lokidoki/bootstrap/versions.py)
   (URL template, filename, sha256 — hand-verified once).
2. Add a preflight module `preflight/<thing>.py` that downloads,
   verifies sha256, extracts if needed, and records a path in
   `ctx.tools` so later code resolves via `ctx.binary_path(...)` /
   equivalent.
3. Register the step in [steps.py](../../../lokidoki/bootstrap/steps.py)
   (`_REAL_RUNNERS`, `_STEP_CATEGORY`, and the `_PRE_MAPS_STACK`
   list).
4. Mirror into [scripts/build_offline_bundle.py](../../../scripts/build_offline_bundle.py)
   so air-gapped Pi installs still work.
5. Delete any runtime CDN URL that the preflight replaces — no
   "just in case" fallbacks (CLAUDE.md: no backwards-compat hacks).

### Pinned upstream sources (seed; chunks re-verify SHAs)

| Name | Source | Size | Why |
|------|--------|-----:|-----|
| basemaps-assets glyphs (Noto Sans) | https://github.com/protomaps/basemaps-assets/archive/refs/tags/<tag>.tar.gz | ~30 MB | Single PBF font stack (`Noto Sans Regular`) covers every Unicode range the style references. Extracted subset is ~5–8 MB. |
| Natural Earth vector data | https://naciscdn.org/naturalearth/packages/natural_earth_vector.sqlite.zip | ~400 MB | planetiler reads country/state polygons, shaded relief seeds. |
| OSM water polygons | https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip | ~800 MB | planetiler uses the coastline/ocean polygons; without them, oceans render as empty space inside the bbox. |

(Natural Earth + water polygons total ~1.2 GB compressed; the user's
installed region bbox only consumes a small slice but planetiler
needs the full files on disk at build time. Cache once in
`data/tools/planetiler/sources/` and every future region install
reuses them.)

### What stays untouched

- Region PBF download (Geofabrik) is already bootstrap-driven per
  install; no change.
- MapLibre vector tile style schema (OpenMapTiles) is unchanged.
- GraphHopper sidecar + routing graph — already fully offline after
  the region install.
- Frontend rendering, theme, zoom behavior — untouched.

### Non-goals

- Shipping Noto fonts for non-Latin scripts (CJK, Arabic). The
  basemaps-assets default font stack already covers Latin + most
  diacritics needed for US/UK/EU regions. If a user installs a
  non-Latin region and labels glyph-miss, surface that as a follow-up
  — not this plan.
- Replacing the `protomaps` source id on the style (keep as-is; it's
  just a name).
- Removing the Protomaps CDN tile fallback — that was already done
  inline in `tile-source.ts` alongside this plan.

---

## NOTE (append as chunks land)

*(empty — chunks add cross-chunk notes or deferrals here)*
