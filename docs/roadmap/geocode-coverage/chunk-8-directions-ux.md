# Chunk 8 — Directions UX: fix step-click map blank + per-row recent delete

## Goal

After this chunk, two long-standing UX papercuts are gone:

1. Clicking a turn in the **Directions** panel no longer blanks the
   map. Today, [DirectionsPanel.tsx::handleStepClick](../../../frontend/src/pages/maps/panels/DirectionsPanel.tsx)
   calls `onFitToCoords(slice)` — and when that slice has degenerate
   bounds (e.g. a single coordinate, or two near-identical coords from
   a "Continue" maneuver) the map's `fitBounds` produces an
   out-of-range zoom or NaN, and MapLibre wipes the canvas. Fix: pad
   the bounds, clamp max zoom, and bail to a `flyTo(midpoint, z=17)`
   when the slice is < 2 distinct points.
2. The **Recents** list in the LeftRail has only a "clear all" affordance.
   Add a hover-revealed `×` button per row that calls a new
   `removeRecent(place_id)` helper.

These are bundled because both are small frontend-only papercuts and
both touch the same area of the LeftRail/Directions code path. Single
chunk, single PR's worth of work.

## Files

- `frontend/src/pages/maps/MapsPage.tsx` (or wherever `onFitToCoords`
  is implemented — locate via `git grep onFitToCoords`) — make the
  helper bounds-safe:
  ```ts
  function fitToCoords(coords: [number, number][]) {
    const distinct = dedupeNearby(coords, 1e-6);
    if (distinct.length < 2) {
      map.flyTo({ center: distinct[0] ?? map.getCenter(), zoom: 17, duration: 600 });
      return;
    }
    const bounds = distinct.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(distinct[0], distinct[0]),
    );
    map.fitBounds(bounds, { padding: 80, maxZoom: 17, duration: 600 });
  }
  ```
  Add a tiny `dedupeNearby(coords, eps)` helper next to it.
- `frontend/src/pages/maps/recents.ts` — add
  `export function removeRecent(placeId: string): Recent[]` that
  loads the list, filters out the matching id, persists, returns the
  new list. Mirror the existing `pushRecent` / `clearRecents`
  pattern.
- `frontend/src/pages/maps/LeftRail.tsx` — extend the recents
  `<li>` rendering: wrap each row in a `group` div, add an
  `<IconButton>` with `<X size={12}/>` that fades in on
  `group-hover:opacity-100`. Click handler calls a new
  `onRemoveRecent(placeId)` prop. Threading the prop through the
  caller (`MapsPage`) is part of this chunk.
- `frontend/src/pages/maps/MapsPage.tsx` (same file as #1) — wire
  `onRemoveRecent` to call `setRecents(removeRecent(placeId))`.
- `frontend/src/pages/maps/recents.test.ts` — add a test
  `removes a single recent by id, leaves others intact`.
- `frontend/src/pages/maps/panels/DirectionsPanel.test.tsx` — add a
  test `step click with single-coord slice falls back to flyTo`
  asserting the existing `onFitToCoords` mock receives a one-coord
  slice and (after the fix) the page's `flyTo` spy fires instead of
  `fitBounds`. If easier, refactor the helper so the fit/fly
  decision lives in a pure function that the test imports
  directly.

Read-only:
- `frontend/src/pages/maps/types.ts` — `Recent` shape (carries
  `place_id`, `title`, `subtitle`).
- `frontend/src/pages/maps/panels/TurnByTurnList.tsx` —
  `onSelect(idx)` callback path, no change needed.

## Actions

1. **Diagnose `handleStepClick`.** From the agent shell, with the
   dev server up, set a `console.log("slice", slice)` inside
   `handleStepClick`, click a "Continue" maneuver, and verify the
   theory (a 1-coord slice causes `fitBounds` to throw or wipe the
   canvas). Remove the log before commit.
2. **Implement bounds-safe fit.** Either inline in `MapsPage.tsx`
   or extract to a tiny `frontend/src/pages/maps/fit-coords.ts`
   helper (preferred — keeps the test simple). The helper takes
   coords + a maplibregl `Map` instance.
3. **`removeRecent` helper.** Mirror `pushRecent`. Simple filter +
   `localStorage.setItem`. No new abstractions.
4. **LeftRail row.** Use `lucide-react`'s `X` icon (already a dep —
   verify with `git grep "from 'lucide-react'" frontend/src` if
   unsure). Rendered with `aria-label={`Remove ${recent.title}`}`,
   focusable, and visible on hover **and** on focus (keyboard
   nav).
5. **Tests** as listed.

## Verify

```
(cd frontend && npx vitest run src/pages/maps/recents.test.ts \
                              src/pages/maps/panels/DirectionsPanel.test.tsx \
                              src/pages/maps/fit-coords.test.ts 2>/dev/null) \
  && (cd frontend && npx tsc --noEmit) \
  && grep -q "removeRecent" frontend/src/pages/maps/recents.ts \
  && echo "OK — removeRecent exported, types compile, step-click + recents tests pass"
```

(If you don't extract `fit-coords.ts`, drop the third path — but the
diagnostic test belongs *somewhere*.)

## Commit message

```
fix(maps): bounds-safe step click + per-row recent delete

handleStepClick fed degenerate single-coord slices into fitBounds,
producing NaN bounds that wiped the MapLibre canvas. Pad bounds, cap
maxZoom at 17, and fall back to a flyTo when the slice has fewer
than 2 distinct points.

Adds removeRecent(placeId) and a hover-revealed × button on each
LeftRail recents row so users can prune a single entry without
nuking the whole list.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 8.
```

## Deferrals

(Empty.)
