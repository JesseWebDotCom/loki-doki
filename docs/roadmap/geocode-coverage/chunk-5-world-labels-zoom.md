# Chunk 5 — World labels visible at all zooms

## Goal

After this chunk, when the user is zoomed in on Connecticut, the
neighboring state and country labels (`MASSACHUSETTS`, `NEW YORK`,
`RHODE ISLAND`, `NEW JERSEY`, `PENNSYLVANIA`) stay visible. Today
they vanish at zoom 8 because both the symbol layers and the
per-feature `max_zoom` property cap at 7.

The fix is two-sided:

1. Lift the layer-level `maxzoom: 7` on `world_place_country` and
   `world_place_state` in the MapLibre style so the layer paints at
   any zoom.
2. Bump the per-feature `max_zoom` default in the world-labels
   GeoJSON builder so existing labels continue painting past z7. Bump
   the cap on which states are emitted in the first place
   (`_STATE_MIN_LABEL_CAP`) so we get *all* US states / Canadian
   provinces / EU regions, not just the high-rank ones.

The world-labels GeoJSON regenerates from the bootstrap on next
`./run.sh` — no runtime fetch needed, no PBF re-extract.

## Files

- `frontend/src/pages/maps/style-dark.ts` — remove `maxzoom: 7` from
  the `world_place_country` and `world_place_state` layer
  definitions. Keep the per-feature filter
  `['<=', ['zoom'], ['get', 'max_zoom']]` so the GeoJSON's own
  per-row max applies. Adjust `text-size` interpolation to fade
  labels down (not out) at high zoom — e.g. countries
  `interpolate linear zoom 1 10 5 20 8 14 12 12`.
- `lokidoki/bootstrap/preflight/world_labels.py` — bump constants:
  - `_STATE_MIN_LABEL_CAP = 10` (from 7) — admits the long tail of
    smaller admin-1 regions.
  - `_COUNTRY_MIN_LABEL_CAP = 8` (from 6) — same logic for
    smaller / less prominent countries.
  - In `_country_features` and `_state_features`, default the
    feature's `max_zoom` to `22` instead of 7. The label still
    *can* be hidden by per-feature NE data, but we no longer
    forcibly cap at z7.
- `frontend/src/pages/maps/style-dark.test.ts` — add an assertion
  that neither `world_place_country` nor `world_place_state` carries
  a `maxzoom` key (so future drive-bys don't reintroduce the cap).

Read-only:
- `lokidoki/bootstrap/preflight/world_labels.py` — full file already
  in scope, but reading the comments at top is required to keep
  the contract intact.

## Actions

1. **Style edits.** In `style-dark.ts`, find the two `world_place_*`
   layer literal objects. Delete the `maxzoom: 7` line from each.
   In the `text-size` `interpolate` arrays, add a high-zoom anchor
   so labels stay readable but de-emphasize: countries
   `[1,10, 5,20, 9,16, 14,14]`, states `[3,10, 7,15, 9,12, 14,11]`.
2. **GeoJSON builder edits.** Bump the two `_*_LABEL_CAP` constants
   and change the `_zoom_floor(row["max_label"], default=7)` calls
   in `_country_features` and `_state_features` to `default=22`.
3. **Re-run the bootstrap world-labels step.** From the agent shell
   the proper way is to delete the existing
   `.lokidoki/tools/planetiler/world-labels.geojson` and re-run
   `./run.sh --maps-tools-only`. Do **not** invoke the preflight
   directly with python — the contract is bootstrap owns install.
4. **Test.** Extend `style-dark.test.ts` with a single test:
   ```ts
   it('keeps world place labels visible at all zooms', () => {
       const style = buildDarkStyle(...);
       const country = style.layers.find(l => l.id === 'world_place_country');
       const state = style.layers.find(l => l.id === 'world_place_state');
       expect(country).toBeDefined();
       expect(state).toBeDefined();
       expect((country as any).maxzoom).toBeUndefined();
       expect((state as any).maxzoom).toBeUndefined();
   });
   ```
5. **Manual verification.** With dev server up, load
   `http://127.0.0.1:8000/maps`, zoom into CT (z9–z11), confirm
   that `MASSACHUSETTS`, `NEW YORK`, `RHODE ISLAND` are visible on
   the surrounding states.

## Verify

```
uv run pytest tests/unit/bootstrap/test_preflight_world_labels.py -q \
  && (cd frontend && npx vitest run src/pages/maps/style-dark.test.ts) \
  && uv run python -c "from lokidoki.bootstrap.preflight.world_labels import \
        _STATE_MIN_LABEL_CAP, _COUNTRY_MIN_LABEL_CAP; \
        assert _STATE_MIN_LABEL_CAP >= 10 and _COUNTRY_MIN_LABEL_CAP >= 8, \
            (_STATE_MIN_LABEL_CAP, _COUNTRY_MIN_LABEL_CAP); \
        print('OK label caps lifted')"
```

## Commit message

```
fix(maps): keep neighbor state/country labels visible past z7

Removes the layer-level maxzoom cap from world_place_country and
world_place_state in the MapLibre style and bumps the per-feature
max_zoom default in the world-labels GeoJSON builder so labels
inherited from Natural Earth keep painting at street-level zooms.
Lifts _STATE_MIN_LABEL_CAP and _COUNTRY_MIN_LABEL_CAP so the long
tail of admin-1 regions and smaller countries also surfaces.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 5.
```

## Deferrals

(Empty.)
