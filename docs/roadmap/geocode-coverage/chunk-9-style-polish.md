# Chunk 9 — Style polish: route shields, water/stream labels, road brightness hierarchy

## Goal

After this chunk, the dark map reads more like a real street map and
less like a sketch:

1. Highway route shields (`I-95`, `US-1`, `CT-15`) render as colored
   pill badges along motorways and trunk roads, sourced from the
   `transportation_name` source-layer's `network` + `ref` fields
   that planetiler already emits.
2. Stream / brook / creek labels render — today only `water_name`
   above z9 paints, so small waterways like *Stubby Plain Brook*
   never surface. Add a `waterway_label` symbol layer using
   `symbol-placement: "line"` on the existing `waterway` source-layer.
3. Road brightness/width hierarchy — motorways pop visibly brighter
   and wider than residential streets; residential drops to a quiet
   line below z14. Right now every road class paints at near the
   same brightness, which flattens the visual hierarchy.

All three are style-layer-only changes — no new data, no rebuild of
pmtiles, no preflight changes. Pure
[style-dark.ts](../../../frontend/src/pages/maps/style-dark.ts) edits
plus a small sprite addition for shield backgrounds.

## Files

- `frontend/src/pages/maps/style-dark.ts` — three blocks of edits:
  - **Route shields**: extend the existing `transportation_name`
    layers with two new sibling symbol layers
    (`route_shield_motorway`, `route_shield_us`,
    `route_shield_state`) that draw a pill background image
    (`text-field` = `['get', 'ref']`, `icon-image` = a per-network
    sprite) at z9+ along motorway/trunk classes. Sprite IDs are
    `shield_interstate`, `shield_us`, `shield_state` — added in
    `frontend/public/sprites/maps-sprite.json` + `.png` (see
    sprite step below).
  - **Stream labels**: new `waterway_label` symbol layer on
    `source-layer: 'waterway'` with `symbol-placement: 'line'`,
    minzoom 12 (rivers/streams are noisy when zoomed out), filter
    `['has', 'name']`. Reuse `p.water_label` palette color.
  - **Road hierarchy**: rebalance the `transportation` line
    layers' `line-width` and `line-color` interpolations:
    motorways `[8,1, 12,3, 16,8]`, trunk `[9,0.8, 12,2, 16,5]`,
    primary `[10,0.6, 14,1.6, 16,3.5]`, residential
    `[13,0.4, 16,1.6, 18,3]`. Pull motorway/trunk colors a step
    brighter (`#7d8590` → `#9aa3ad`); residential stays muted
    (`#3a3f47`).
- `frontend/public/sprites/maps-sprite.png` (new, ~4 KB) and
  `frontend/public/sprites/maps-sprite@2x.png` (new) — three pill
  backgrounds (interstate red, US shield green, state circle
  beige) at 1x and 2x. Generate with a tiny inkscape / svgo
  pipeline or hand-author 24×24 PNGs; commit the PNGs (these are
  *first-party UI assets* per CLAUDE.md, NOT vendored upstream
  binaries).
- `frontend/public/sprites/maps-sprite.json` (new) and
  `frontend/public/sprites/maps-sprite@2x.json` (new) — the
  MapLibre [sprite JSON spec](https://maplibre.org/maplibre-style-spec/sprite/)
  describing each icon's pixel offsets in the PNG.
- `frontend/src/pages/maps/MapsPage.tsx` (or wherever the
  MapLibre `Map` is constructed) — set
  `style.sprite = '/sprites/maps-sprite'` on the style object so
  MapLibre auto-resolves `@2x` for retina.
- `frontend/src/pages/maps/style-dark.test.ts` — extend with:
  - `it('renders interstate shields above motorways')` — assert
    a layer with id matching `/^route_shield_/` exists and uses
    the `transportation_name` source-layer.
  - `it('renders waterway names along stream lines')` — assert
    a `waterway_label` layer with `symbol-placement: 'line'`.
  - `it('motorway lines are brighter than residential')` — pull
    both layer colors and parse hex; assert motorway luminance
    > residential.

Read-only:
- The `transportation_name` source-layer field shape
  (`class`, `network`, `ref`, `name`) — confirm via a quick
  `npx pmtiles tile data/maps/us-ct/streets.pmtiles 14 4823 6160`
  if uncertain. Don't add this command to the verify; use it for
  exploration only.

## Actions

1. **Author the sprite assets first.** The shield images are tiny
   and hand-authoring is faster than scripting. Use the standard
   MUTCD-ish color cues:
   - `shield_interstate`: 24×24, rounded rect, fill `#1f3b8b`
     (interstate blue), top stripe `#c1272d` (interstate red),
     white text area.
   - `shield_us`: 24×24, classic US-route badge silhouette in
     `#2a2a2a` outline + `#f5f5f5` fill.
   - `shield_state`: 24×24, circle in `#5a5a5a` outline + cream
     `#f0e7c8` fill.
   Author the sprite JSON manifest by hand — three entries, each
   `{x, y, width, height, pixelRatio}`. Generate `@2x` by
   doubling everything.
2. **Wire sprite URL** in MapsPage's `style` object. Verify the
   network panel shows `/sprites/maps-sprite.json` + `.png`
   resolving 200.
3. **Route shield layers.** Append after the existing
   `transportation_name` layers so they render on top. Shape:
   ```ts
   {
     id: 'route_shield_motorway',
     type: 'symbol',
     source: 'protomaps',
     'source-layer': 'transportation_name',
     filter: ['all',
       ['==', ['get', 'class'], 'motorway'],
       ['has', 'ref'],
     ],
     minzoom: 9,
     layout: {
       'symbol-placement': 'line',
       'symbol-spacing': 350,
       'icon-image': 'shield_interstate',
       'icon-text-fit': 'both',
       'icon-text-fit-padding': [2, 4, 2, 4],
       'text-field': ['get', 'ref'],
       'text-font': ['Noto Sans Bold'],
       'text-size': 11,
     },
     paint: { 'text-color': '#ffffff' },
   }
   ```
   Variants for `class == 'trunk'` (US shield) and `class == 'primary'`
   with `network == 'us-state:*'` (state shield).
4. **Stream labels.** New layer at the end of `water_and_poi_labels`:
   ```ts
   {
     id: 'waterway_label',
     type: 'symbol',
     source: 'protomaps',
     'source-layer': 'waterway',
     filter: ['has', 'name'],
     minzoom: 12,
     layout: {
       'symbol-placement': 'line',
       'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
       'text-font': ['Noto Sans Italic'],
       'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 18, 13],
       'text-letter-spacing': 0.05,
     },
     paint: {
       'text-color': p.water_label,
       'text-halo-color': p.water_label_halo,
       'text-halo-width': 1.0,
     },
   }
   ```
5. **Road hierarchy rebalance.** Carefully edit each existing
   `transportation` line layer's `line-width` and `line-color`
   interpolations as listed under "Road hierarchy" above. Don't
   add new layers — this is a values-only edit.
6. **Tests** as listed. The motorway-vs-residential luminance
   test is the load-bearing one — it pins the hierarchy
   intention so a future edit can't accidentally flatten it
   again.
7. **Manual verification.** Dev server up, load the Milford CT
   area at z11 and confirm:
   - I-95 shows a blue interstate badge with `95` along the
     motorway.
   - US-1 shows a US-shield badge.
   - *Stubby Plain Brook* renders along the stream line at z14.
   - Motorways read as visibly brighter than side streets.

## Verify

```
(cd frontend && npx vitest run src/pages/maps/style-dark.test.ts) \
  && (cd frontend && npx tsc --noEmit) \
  && test -f frontend/public/sprites/maps-sprite.png \
  && test -f frontend/public/sprites/maps-sprite@2x.png \
  && test -f frontend/public/sprites/maps-sprite.json \
  && python3 -c "import json,sys; \
        m=json.load(open('frontend/public/sprites/maps-sprite.json')); \
        need={'shield_interstate','shield_us','shield_state'}; \
        missing=need - set(m); \
        sys.exit(f'missing sprite ids: {missing}') if missing else print('OK sprite ids:', sorted(m))"
```

## Commit message

```
feat(maps): route shields, stream labels, road brightness hierarchy

Adds three style-layer polish passes that make the dark map read
like a real street map:

- New route_shield_{motorway,us,state} symbol layers paint MUTCD-ish
  pill badges along motorway/trunk/primary roads using the existing
  transportation_name source-layer's ref + network fields.
- New waterway_label layer renders stream/brook names along the
  waterway centerline at z12+ (Stubby Plain Brook etc.) — water_name
  alone topped out at lakes/rivers from z9.
- Rebalances transportation line widths + colors so motorways pop
  brighter and wider than residential streets at every zoom.

Sprite assets are first-party UI PNGs at frontend/public/sprites/.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 9.
```

## Blocker

- 2026-04-19 — `frontend/src/pages/maps/style-dark.test.ts` passes and
  the sprite assets are present, but the required verify command still
  fails at `npx tsc --noEmit` before chunk-specific typing is fully
  evaluated because `frontend/tsconfig.json` triggers `TS5101`:
  Option `baseUrl` is deprecated and now requires
  `"ignoreDeprecations": "6.0"` (or a config migration). That config
  file is outside chunk 9's declared scope, so this chunk cannot be
  committed until the repo-level TypeScript config issue is cleared.

## Deferrals

(Empty.)
