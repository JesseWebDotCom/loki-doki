# Chunk 10 — POI icon sprite + click-to-popup PlaceDetailsCard

## Goal

After this chunk, the map shows colored category icons for points of
interest (restaurants, shops, banks, transit stops, hospitals, etc.)
sourced from the existing `poi` source-layer in the streets pmtiles,
and clicking any POI **or** any building polygon opens the existing
[PlaceDetailsCard.tsx](../../../frontend/src/pages/maps/panels/PlaceDetailsCard.tsx)
floating panel with the feature's name, address, coordinates, and the
Directions / Save buttons it already renders.

This is the "Apple-Maps-like" pass — POI density goes from "nothing"
to "every Starbucks, ShopRite, and Wells Fargo within visible bounds
gets a tappable pin." Combined with chunk 3 (named POIs in the
geocoder) the user can both *see* a POI on the map and *find* it via
search.

## Files

- `frontend/public/sprites/maps-sprite.json` (extended) and the
  `.png` / `@2x.png` siblings — add ~30 category icons. Reuse the
  free [Maki icons](https://labs.mapbox.com/maki-icons/) (CC0; ship
  the SVGs we use as part of `frontend/public/sprites/source/`
  for traceability — these are first-party assets per CLAUDE.md
  because they're CC0 and small). Categories needed:
  `restaurant`, `cafe`, `fast_food`, `bar`, `pub`, `grocery`,
  `shop`, `convenience`, `pharmacy`, `bank`, `atm`, `gas`,
  `parking`, `school`, `hospital`, `clinic`, `library`, `museum`,
  `hotel`, `lodging`, `transit_bus`, `transit_train`,
  `transit_subway`, `airport`, `park`, `place_of_worship`,
  `post`, `police`, `fire_station`, `default`.
- `frontend/src/pages/maps/style-dark.ts` — replace the existing
  text-only `poi` layer with two stacked layers:
  - `poi_icon` (type symbol) — `icon-image` resolved by a
    `match` expression against the `class`/`subclass` field
    planetiler emits. Coloring done via the icon PNG itself
    (Maki icons come in white; we tint with paint
    `icon-color: <category color>`).
  - `poi_label` — same as today's `poi` layer but `text-anchor:
    'top'` + `text-offset: [0, 1.0]` so the label sits below
    the icon.
  Add a per-category color map at module top
  (`POI_COLORS: Record<string, string>`).
- `frontend/src/pages/maps/MapsPage.tsx` — add a single
  `map.on('click', handler)` that calls
  `map.queryRenderedFeatures(e.point, { layers: ['poi_icon',
  'building-extrusion', 'building'] })` (whichever building layer
  ids exist) and opens `PlaceDetailsCard` with the top-most hit.
  When the hit is a building polygon **without** a name, fall
  back to a reverse-geocode call (`/api/v1/maps/geocode/reverse`,
  see route addition below) so the popup still shows
  `<housenumber> <street>` rather than empty.
- `lokidoki/api/routes/maps.py` — new route
  `GET /geocode/reverse?lat=...&lon=...` that returns the nearest
  FTS row (Haversine via existing `haversine_km`) within ~50 m.
  Body: `{title, subtitle, lat, lon, place_id, source}`. Pure
  server-side; reuses the per-region SQLite fanout already in
  `fts_search.search()`.
- `lokidoki/maps/geocode/fts_search.py` — extend with
  `nearest(lat, lon, regions, data_root, max_radius_km=0.05)`.
  Implementation: `SELECT … FROM places WHERE lat BETWEEN ? AND ?
  AND lon BETWEEN ? AND ?` with a coarse bbox filter, then
  Haversine-rank the candidates in Python. No new index needed —
  the bbox filter is fast enough at city scale.
- `frontend/src/pages/maps/panels/PlaceDetailsCard.tsx` —
  small extension: accept an optional `category` prop, render
  the matching Maki icon next to the title. No new behavior —
  same Directions / Save / Share buttons.
- `tests/unit/test_geocode_reverse.py` — new. Three tests:
  exact-coord hit returns the row, off-by-100m returns null
  (out of radius), multi-region fanout works.
- `frontend/src/pages/maps/MapsPage.test.tsx` — extend with
  `it('opens PlaceDetailsCard when a POI is clicked')` using
  a fake `queryRenderedFeatures` that returns one feature.

Read-only:
- The `poi` source-layer's field shape (planetiler OpenMapTiles
  schema): `class` (e.g. `restaurant`), `subclass`, `name`. The
  `class` enum is documented at
  https://openmaptiles.org/schema/#poi.

## Actions

1. **Vendor the Maki SVGs.** Copy the ~30 SVGs we use from the
   Maki release (CC0) into `frontend/public/sprites/source/`.
   Build them into the existing sprite PNG via [spritezero](https://github.com/mapbox/spritezero-cli)
   — IF the tool is already in `frontend/package.json`. If not,
   add it through `package.json` (the bootstrap installs Node
   deps; do NOT `npm i` from the agent shell). Output:
   `frontend/public/sprites/maps-sprite.png` and `.json`.
2. **Stop the existing `poi` text-only layer from rendering.**
   Either rename it to `poi_label` and adjust offsets, or delete
   it and replace with the two-layer pair.
3. **Author the icon + label layers.** The `match` expression
   for `icon-image`:
   ```ts
   ['match',
     ['get', 'class'],
     'restaurant', 'restaurant',
     'cafe', 'cafe',
     ['fast_food', 'food_court'], 'fast_food',
     // ...
     'default'  // fallback
   ]
   ```
   Pair with `'icon-color': ['match', ['get', 'class'], …]` for
   per-category tinting. POI minzoom 14 stays.
4. **Reverse-geocode helper + route.** Implement
   `nearest()` first (server-side), then the route. The route
   reuses `_regions_for_viewport(lat, lon)` so the fanout
   matches `/geocode`.
5. **Map click handler.** In `MapsPage.tsx`, after the map
   instance is constructed:
   ```ts
   map.on('click', async (e) => {
     const features = map.queryRenderedFeatures(e.point, {
       layers: ['poi_icon', 'buildings-3d', 'buildings'],
     });
     const top = features[0];
     if (!top) return;
     if (top.properties?.name) {
       openPlaceCard({
         title: top.properties.name,
         subtitle: subtitleFromProps(top.properties),
         lat: e.lngLat.lat, lon: e.lngLat.lng,
         category: top.properties.class,
       });
     } else {
       const r = await reverseGeocode(e.lngLat.lat, e.lngLat.lng);
       if (r) openPlaceCard(r);
     }
   });
   ```
6. **Tests** as listed.
7. **Manual verification.** Pan to Milford CT town center, zoom
   to z16. Confirm:
   - Multiple colored POI pins visible (restaurant orange, bank
     blue, etc.)
   - Click on a POI → PlaceDetailsCard opens with the right
     name/address.
   - Click on an unnamed residential building → card opens with
     the address from reverse-geocode.

## Verify

```
uv run pytest tests/unit/test_geocode_reverse.py \
              tests/unit/test_geocode_fts_search.py -q \
  && (cd frontend && npx vitest run src/pages/maps/MapsPage.test.tsx \
                                    src/pages/maps/style-dark.test.ts) \
  && (cd frontend && npx tsc --noEmit) \
  && python3 -c "import json,sys; \
        m=json.load(open('frontend/public/sprites/maps-sprite.json')); \
        need={'restaurant','cafe','grocery','bank','pharmacy','hospital', \
              'gas','hotel','school','park','default'}; \
        missing=need - set(m); \
        sys.exit(f'missing POI sprite ids: {missing}') if missing else \
            print('OK POI sprites:', len(m), 'icons')"
```

## Commit message

```
feat(maps): POI category icons + click-to-open PlaceDetailsCard

The existing `poi` source-layer was being rendered as bare text
labels at z14+. This chunk replaces that with proper Apple-Maps-style
colored category icons (Maki, CC0) for ~30 POI classes -- restaurant
warm orange, bank blue, transit green, etc. -- with the text label
re-anchored below the icon.

Adds a map click handler that runs queryRenderedFeatures across the
poi_icon + building layers and opens PlaceDetailsCard with the
matched feature's name/address. Unnamed building clicks fall back
through a new GET /geocode/reverse route to the nearest FTS row
within 50m.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 10.
```

## Deferrals

(Empty.)
