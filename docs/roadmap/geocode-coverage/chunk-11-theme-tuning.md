# Chunk 11 — Dark theme tuning + light theme + system-theme toggle

## Goal

After this chunk, the dark map looks like a **map** instead of a
flat sketch — landuse has subtle tinting (parks lean green, urban
slightly warmer), water reads as saturated blue (not just dark
blue), and the road brightness hierarchy from chunk 9 has matching
landuse contrast underneath. A new **light theme** ships
side-by-side, and the active theme follows the user's system
appearance by default with a manual override in Settings.

This is the polish chunk that makes the map feel finished. Apple
Maps, Google Maps, Mapbox Dark, Carto Dark Matter — all use these
exact tricks (subtle landuse tint, brighter water, hierarchy
contrast). Documented in
[Mapbox's "Designing for cartography" guide](https://docs.mapbox.com/help/tutorials/customize-tiles-with-mapbox-studio/)
and [Carto's Dark Matter design notes](https://carto.com/blog/getting-to-know-positron-and-dark-matter/).

## Files

- `frontend/src/pages/maps/style-dark.ts` — three groups of edits:
  - **Palette extension**: add `landuse_park`, `landuse_residential`,
    `landuse_commercial`, `landuse_industrial`, `landuse_wood`
    fields to the `Palette` interface and dark/light values.
    Dark values are very-low-saturation tints over the base land
    color (e.g. park `#1c2620`, wood `#1a221c`, urban `#1f1d22`).
  - **Landuse layers**: add fill layers on the `landuse` and
    `park` source-layers planetiler emits, drawn just above the
    base `earth` fill and below roads. Keep opacity ~0.5 so the
    tint reads but doesn't shout.
  - **Water saturation**: bump dark `water` from the current
    flat blue to a deeper `#0f2944` plus a faint
    `water-shadow` outline (1 px line layer with the same
    color at lower alpha) for visible coastlines.
- `frontend/src/pages/maps/style-light.ts` — **new**, mirrors
  the structure of `style-dark.ts`. Light palette draws from
  Apple Maps Light + Mapbox Streets — base land `#f5f1e8`,
  water `#aad3df`, park `#dde9bd`, primary roads `#ffffff`,
  motorway shields colored as in chunk 9.
- `frontend/src/pages/maps/style-factory.ts` — **new**, single
  exported `buildStyle(theme: 'dark' | 'light', ...args)` that
  delegates to the dark / light builders. Centralizes the
  "which theme to load" decision.
- `frontend/src/pages/maps/MapsPage.tsx` — replace the direct
  `style-dark` import with `style-factory`. Read the active
  theme from a new `useMapTheme()` hook (below). On theme change,
  call `map.setStyle(buildStyle(newTheme, ...))`.
- `frontend/src/pages/maps/use-map-theme.ts` — **new** hook.
  Returns `{ theme: 'dark' | 'light', setTheme }`. Source order:
  (1) localStorage `lokidoki.mapTheme` value if `'light' |
  'dark'`; (2) the literal string `'system'` → fall back to
  `window.matchMedia('(prefers-color-scheme: dark)').matches`.
  Subscribes to media-query changes so a system-level theme
  flip propagates without reload.
- `frontend/src/components/settings/MapsSection.tsx` — add a
  small radio group: *Theme: System / Light / Dark*. Persists to
  the same `lokidoki.mapTheme` localStorage key the hook reads.
- `frontend/src/pages/maps/style-dark.test.ts` — extend with
  `it('emits landuse fills with subtle dark tints')` — assert
  layer ids include `landuse_park`, `landuse_wood`, etc., and
  their `fill-color` parses as a near-base-land hex.
- `frontend/src/pages/maps/style-light.test.ts` — **new**.
  Mirrors the dark test for the light palette. Assert
  `style.layers.find(l=>l.id==='water').paint['fill-color']`
  is a recognizable light blue (luminance > dark water).
- `frontend/src/pages/maps/use-map-theme.test.ts` — **new**.
  Cover: default `'system'` reads matchMedia; explicit
  `'dark'` overrides; subscribing to mediaQuery change fires
  the setter.

Read-only:
- The `landuse` source-layer's class enum from planetiler
  (`residential`, `commercial`, `industrial`, `cemetery`,
  `park`, `wood`, `military`, etc.).
- `frontend/src/components/settings/MapsSection.tsx` for
  the existing toggle pattern.

## Actions

1. **Refactor `style-dark.ts` into a builder.** Extract the
   palette + layer-group functions into a shape
   `buildDarkStyle(args)` returns. The existing default export
   becomes `buildDarkStyle({...})`. Zero behavior change yet.
2. **Author `style-light.ts`** with the mirrored shape. Use the
   palette anchors from Apple Maps Light cited above.
3. **Add `style-factory.ts`** as a thin dispatcher.
4. **Add landuse layers + palette extensions** in BOTH theme
   modules. Dark tints are extremely subtle (within 6 %
   luminance of base land). Light tints are stronger (parks
   visibly green) since light backgrounds tolerate more
   saturation.
5. **Tune water** in both themes. Dark gets `#0f2944` +
   `water-shadow` outline; light keeps the conventional
   `#aad3df`.
6. **`use-map-theme` hook + Settings UI.** Standard
   `useState` + `useEffect` for the matchMedia subscription.
   Persist via localStorage; fire a custom `'lokidoki.mapTheme'`
   event so other tabs / hook instances stay in sync.
7. **Tests** as listed. The luminance assertions are the
   load-bearing ones — they pin the design intent.
8. **Manual verification.** Dev server up, toggle the Settings
   radio:
   - Dark default reads as a real map (parks subtly green-ish,
     water deeper blue, road hierarchy obvious).
   - Light theme renders cleanly without overlapping label
     halos.
   - Flipping system appearance (`defaults write -g
     AppleInterfaceStyle Dark`) flips the map theme when the
     setting is `'system'`.

## Verify

```
(cd frontend && npx vitest run src/pages/maps/style-dark.test.ts \
                              src/pages/maps/style-light.test.ts \
                              src/pages/maps/use-map-theme.test.ts) \
  && (cd frontend && npx tsc --noEmit) \
  && grep -q "buildStyle" frontend/src/pages/maps/style-factory.ts \
  && grep -q "landuse_park" frontend/src/pages/maps/style-dark.ts \
  && grep -q "landuse_park" frontend/src/pages/maps/style-light.ts \
  && echo "OK both themes ship landuse + factory wired"
```

## Commit message

```
feat(maps): dark theme tuning + light theme + system-theme toggle

The dark map was monochrome -- no landuse contrast, flat water,
uniform road brightness. This chunk:

- Adds subtle landuse tints (parks slightly green, urban warmer,
  industrial slightly bluer) and a saturated water color so the
  base map reads as a real cartographic surface, not a sketch.
- Ships a parallel light theme (style-light.ts) drawn from Apple
  Maps Light / Mapbox Streets palette anchors.
- Adds a use-map-theme hook + Settings radio (System / Light /
  Dark). Default 'System' subscribes to prefers-color-scheme so
  the map flips when macOS appearance flips.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 11.
```

## Deferrals

(Empty.)

## Blocker

- 2026-04-19 — `cd frontend && npx tsc --noEmit` fails before chunk 11
  can be marked done because `frontend/tsconfig.json` still raises
  `TS5101: Option 'baseUrl' is deprecated` and this chunk's file scope
  does not include `frontend/tsconfig.json`. Targeted vitest checks for
  this chunk pass; full verify is blocked on the repo-level TypeScript
  config issue already recorded against chunks 8–10.
