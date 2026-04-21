# LokiDoki Bug Tracker

Active issues discovered in production UX that aren't yet fixed. Close
by deleting the row when the fix lands (link the commit in the PR).

| ID | Area | Status | Summary |
| -- | ---- | ------ | ------- |
| BUG-1 | Maps / hover | open | Duplicate hover cards per business — one renders with icon + category, the other is missing both |
| BUG-2 | Maps / POI layer | open | Named businesses missing from the map but appear on building hover |

---

## BUG-1 — Duplicate hover cards per business

**Where:** `frontend/src/pages/MapsPage.tsx` — `poi_icon` vs `buildings-3d`/`buildings-2d` hover handlers.

**Symptom:** Moving the cursor across a single business can surface two
different hover cards depending on where the cursor lands:
- Over the POI glyph → full card with subclass icon + category label.
- Over the building footprint → card with the same name/address but no
  icon badge and no category chip (or a coarser one).

**Likely cause:** two independent code paths build the hover target.
The `poi_icon` path reads `subclass`/`class` straight off the vector
tile and maps it via `POI_CATEGORY_ICON`, while the building path goes
through `hydrateBuildingHover` → `reverseGeocode` and depends on the
FTS `category` column being granular (`poi:<key>:<value>`). Legacy
indices that still store the coarse `poi:<key>` form fall back to the
top-level key icon (`amenity → default`), which visually reads as
"no category." When the two paths race during cursor drift, the user
perceives "two cards, one missing category."

**Repro:**
1. Install an older region (FTS built before the subclass change).
2. Hover the POI glyph for a named business — card A appears with icon.
3. Slide the cursor onto the same building's footprint — card B appears
   without the subclass icon / label.

**Fix direction:**
- Unify the two hover paths so the building path reuses the tile
  feature's `subclass` when the cursor lands on a footprint that hosts
  a POI glyph (cheap: `queryRenderedFeatures` at the pointer against
  `poi_icon` before falling back to reverse-geocode).
- Force-rebuild the FTS index on upgrade so every installed region
  emits `poi:<key>:<value>` (today, only freshly built indices do).
- Add a test that simulates the drift sequence (mousemove POI →
  mousemove building on the same business) and asserts both cards
  carry the same icon + category.

---

## BUG-2 — Named businesses missing from the map until hovered

**Where:** map style + tile pipeline — `frontend/src/pages/maps/style-dark.ts`
(`poi_icon` layer) and the planetiler POI profile the bootstrap builds.

**Symptom:** A real business that the geocoder knows about (e.g.
"Planet Fitness" at 177 Cherry Street) renders as a bare housenumber
("177") on the basemap. Hovering the building synthesises a hover card
correctly because the FTS nearest-neighbour finds the POI — but the
user had no visual hint the business was there.

**Likely cause:** the vector tile's `poi` source-layer doesn't include
every named business the FTS index carries. Possible contributors:
- The planetiler profile filters on a stricter key/value list than the
  FTS indexer (`_POI_KEYS` in `lokidoki/maps/geocode/fts_index.py`).
- Certain subclass values (`leisure=fitness_centre`, `office=company`,
  some `shop=*` combos) get dropped by the planetiler POI profile.
- Way-centroid POIs (named buildings with no standalone node) survive
  in the FTS row but are absent from the tile's point POI layer.

**Repro:**
1. Open the map at 177 Cherry Street, Milford CT (or any other named
   business you know lives in the FTS index).
2. Observe only the housenumber renders — no icon/label badge.
3. Move cursor over the building → hover card for the business pops.

**Fix direction:**
- Audit the planetiler POI profile used by the bootstrap tile build;
  widen it to match the FTS `_POI_KEYS` list.
- Emit tile POIs for named building polygons via centroid so
  way-only POIs render.
- Add a tile-build smoke test that renders a fixture region and
  asserts every FTS `poi:*` row has a matching `poi` tile feature
  within ~50 m.
- Until the tile profile is fixed, consider a runtime overlay that
  reads the FTS index and draws a lightweight symbol layer for any
  business missing from the tile POI layer.
