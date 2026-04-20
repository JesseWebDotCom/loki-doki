# Chunk 16 — Hover-preview PlaceDetailsCard on POI icons

## Goal

After this chunk, hovering a POI pin on the map (`poi_icon` layer from
chunk 10) pops a compact preview card with the name + category icon +
one-line subtitle, anchored near the pin. Clicking the pin still opens
the full PlaceDetailsCard floating panel that chunk 10 wired. The
hover card is ephemeral — disappears when the cursor leaves the icon —
and does NOT swap the active tab or change selection state. This is
the Apple-Maps / Google-Maps pattern the user expected after chunk 10
shipped "click-only".

The hover card is **preview-only**: no buttons, no route prompt, no
Directions / Save affordances. The click path still owns those.

## Files

- `frontend/src/pages/maps/panels/PoiHoverPreview.tsx` — **new**,
  small. Accepts `{ name, subtitle, category, screenX, screenY }`.
  Renders a fixed-position div using the Onyx Material card primitive
  (border, shadow, rounded corners). Pure presentation; no state.
- `frontend/src/pages/MapsPage.tsx` — add two `map.on` handlers
  and a `hoverTarget` state slot:
  - `map.on('mousemove', 'poi_icon', (e) => { ... })` — cursor
    pointer + setHoverTarget({ feature: e.features[0], x, y }).
  - `map.on('mouseleave', 'poi_icon', () => setHoverTarget(null))`.
  - Render `<PoiHoverPreview ... />` when `hoverTarget` is set.
  Thread the existing `reverseGeocode` fall-through if the
  feature has no `name` — reuse, don't duplicate.
  `queryRenderedFeatures` is NOT needed here; the per-layer
  `mousemove` subscription already gives us the feature.
- `frontend/src/pages/maps/panels/PoiHoverPreview.test.tsx` —
  **new**. Render directly (not through MapsPage) with a fake
  feature; assert the name + subtitle + category icon render,
  and that the card is positioned at the given coords.
- `frontend/src/pages/MapsPage.test.tsx` — extend with
  `it('shows a hover preview when cursor enters a POI icon')`.
  Reuse the existing `mapHandlers` event-bus mock pattern; add
  a 'mousemove' fire on the `poi_icon` layer and assert the
  preview element appears, then a 'mouseleave' and assert it
  disappears. The handler-registration mock already in the file
  makes this cheap.

Read-only:
- `frontend/src/pages/maps/panels/PlaceDetailsCard.tsx` — the
  click-opened full card. Lift the category → icon lookup into a
  shared helper (`poiCategoryIconId(category)`) if both files
  need it; do NOT re-author the icon map.
- `frontend/src/pages/MapsPage.tsx:175::reverseGeocode` — reuse
  when hovering an unnamed building (rare, but consistent with
  the click-path fallback).

## Actions

1. **Extract `poiCategoryIconId`** if needed so hover + click
   share one mapping. If chunk 10 already has this colocated
   in `PlaceDetailsCard.tsx`, lift to
   `frontend/src/pages/maps/panels/poi-icons.ts` and import from
   both. Keep it tiny.
2. **Author `PoiHoverPreview.tsx`.** Fixed-position (`position:
   fixed`, `left: screenX + 12`, `top: screenY + 12`), z-index
   above the map canvas but below floating panels. Use the
   Onyx Material card/ popover primitive so the visual language
   matches the full details card.
3. **Wire the two MapLibre handlers** in MapsPage. Debounce
   `mousemove` at ~33 ms (rAF) so the re-render cost is bounded
   on hover-drag across many pins.
4. **Use `map.getCanvas().style.cursor`** to show a pointer
   cursor over POI icons (tiny UX win; the click-to-open is
   otherwise undiscoverable).
5. **Tests** as listed. The `PoiHoverPreview` unit test pins the
   rendering contract; the MapsPage test pins the event wiring.
6. **Manual verification.** Dev server up, zoom to Milford CT
   town center at z16:
   - Hover a restaurant pin → small preview card appears next
     to the cursor with the name + orange dot + subtitle.
   - Move cursor off → card disappears.
   - Click the same pin → full PlaceDetailsCard opens as
     before (regression check on chunk 10).

## Verify

```
(cd frontend && npx vitest run \
    src/pages/maps/panels/PoiHoverPreview.test.tsx \
    src/pages/MapsPage.test.tsx) \
  && (cd frontend && npx tsc -b) \
  && grep -q "mousemove" frontend/src/pages/MapsPage.tsx \
  && grep -q "PoiHoverPreview" frontend/src/pages/MapsPage.tsx \
  && echo "OK hover preview wired"
```

## Commit message

```
feat(maps): hover preview card on POI icons

Chunk 10 shipped click-to-open PlaceDetailsCard but no hover
affordance, so POI pins were undiscoverable unless the user
experimentally clicked. Apple Maps / Google Maps pop a compact
preview on hover and reserve the full details panel for click;
mirror that pattern.

Adds PoiHoverPreview -- a fixed-position Onyx card rendered on
`mousemove 'poi_icon'` and dismissed on `mouseleave`. Pure preview,
no buttons; click path still owns Directions / Save. Pointer
cursor also surfaces hit-testability at the icon.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 16.
```

## Deferrals

(Empty.)
