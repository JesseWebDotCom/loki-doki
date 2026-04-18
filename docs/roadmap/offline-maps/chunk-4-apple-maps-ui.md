# Chunk 4 — Apple Maps-style left rail + place-details card

## Goal

Reframe `/maps` as an Apple Maps–style two-pane layout. **Left rail** (fixed ~320 px): app mark + "BETA" chip, three primary items (**Search**, **Guides**, **Directions**), a collapsed "Recents" list, and a footer "Have a Business on Maps?" slot (disabled/hidden for LokiDoki — replaced with a "Manage regions" link to Settings → Maps). **Center content** per active item: Search renders an autocomplete list over the map; picking a result drops a pin and opens a **place-details card** (title, subtitle, full address block, blue **Directions** button). **Right pane** is still the map, now sized to flex. Mode toggle, layer chip, and out-of-coverage banner (from Chunk 3) stay anchored in the map surface.

This chunk is pure UI scaffolding — it must work with the existing online Nominatim search. Chunk 5 swaps geocoding to offline FTS5. Chunk 7 wires the Directions item. "Guides" is a disabled placeholder (tooltip: "Coming soon") — still rendered so the navigation structure matches the reference.

## Files

- `frontend/src/pages/MapsPage.tsx` — restructure from single-column to `LeftRail + MapSurface` grid. Search-box and pin logic moves into the new panels.
- `frontend/src/pages/maps/LeftRail.tsx` — new: brand + nav items + Recents section + footer slot. Active-item state lifts to `MapsPage`.
- `frontend/src/pages/maps/panels/SearchPanel.tsx` — new: the search box + autocomplete dropdown; `onSelect(result)` drops a pin and opens `PlaceDetailsCard`.
- `frontend/src/pages/maps/panels/PlaceDetailsCard.tsx` — new: header (title + linked city/region), prominent blue `Directions` button (stub action until Chunk 7), `Details` section with the address block + one-tap "copy to directions" arrow.
- `frontend/src/pages/maps/panels/GuidesPanel.tsx` — new: empty-state placeholder ("Curated places coming soon — install a region and browse by category.") with disabled category tiles.
- `frontend/src/pages/maps/panels/DirectionsPanelPlaceholder.tsx` — new: a disabled skeleton of the Directions panel (From / To pills, mode chips) — greyed out with a tooltip "Ships in Chunk 7." Keeps the left-rail target link valid.
- `frontend/src/pages/maps/recents.ts` — new: `loadRecents()` / `pushRecent(result)` helpers backed by `localStorage.lokidoki.maps.recents` (cap 10).
- `frontend/src/pages/maps/types.ts` — new: shared `PlaceResult`, `ActivePanel`, `Recent` types.
- `frontend/src/pages/maps/panels/SearchPanel.test.tsx` — new vitest.
- `frontend/src/pages/maps/recents.test.ts` — new vitest.

Read-only: `frontend/src/pages/maps/style-dark.ts`, `frontend/src/pages/maps/LayerModeChip.tsx`, `frontend/src/pages/maps/OutOfCoverageBanner.tsx`.

## Actions

1. **Layout restructure in `MapsPage.tsx`**:
   - Replace the current top-bar search with a two-column CSS grid: `grid-template-columns: 320px 1fr;`. On narrow widths (<900 px), the rail collapses to a hamburger (shadcn `Sheet`) — not in-scope to prettify now, but do not break it.
   - Lift `activePanel: "search" | "guides" | "directions"` and `selectedPlace: PlaceResult | null` to the page. Default `activePanel = "search"` on first load. A close button on any panel returns to `null` (empty map view).
2. **`LeftRail.tsx`**:
   - Top: Maps mark + `BETA` shadcn `Badge`. Below: a sidebar toggle icon (mirrors the Apple reference — collapses the rail to icons only; use shadcn's collapsible). 
   - Nav list (pill row per item) for Search / Guides / Directions — Lucide icons match Apple's (`Search`, `LayoutGrid`, `ArrowRightLeft` or `Route`). Active item gets Elevation-2 background + Material Purple accent.
   - `Recents` section: collapsible header `Recents ›`; list of up to 5 recents from `recents.ts`, each row = red pin icon + title + subtitle. Clicking a recent rehydrates it as `selectedPlace` and opens `PlaceDetailsCard`.
   - Footer: small card "Manage map regions ↗" linking to `/settings/archives#maps`.
3. **`SearchPanel.tsx`**:
   - Header `Search` + close button.
   - `Input` with magnifying-glass icon + `Clear` (`X`) affordance when non-empty (matches the reference).
   - Debounced autocomplete (300 ms). Today this hits Nominatim online as MapsPage does now; Chunk 5 swaps the fetch target to `/api/v1/maps/geocode`. The client has no awareness of which backend — it calls a single `searchPlaces(query, viewportCenter)` helper.
   - Results dropdown: up to 5 rows, each with pin icon + title + muted subtitle. A result hover highlights a transient marker on the map; click commits it as `selectedPlace`, pushes to `recents`, and transitions the active panel to show `PlaceDetailsCard`.
4. **`PlaceDetailsCard.tsx`**:
   - Header: title `text-2xl`, a muted `Address · ${city, region}` line where the region is a text link to re-run a search for that area.
   - Blue full-width **Directions** button (Elevation-4 purple — matches `.bg-primary` in our tokens). For this chunk, clicking it switches `activePanel` to `"directions"` and pre-fills the `To` field in the placeholder; real routing lands in Chunk 7.
   - **Details** section: a card with the full address block and a round arrow (↗) button that copies the place to the clipboard as a formatted address string.
5. **`GuidesPanel.tsx`** and **`DirectionsPanelPlaceholder.tsx`** — ship as minimal placeholders so the rail items are not dead ends. Label the Directions placeholder `Coming soon — ships with routing in Chunk 7`.
6. **`recents.ts`** — `loadRecents()` returns the last 10 (newest first), `pushRecent()` dedupes by `place_id` and caps to 10. Keys: `lokidoki.maps.recents.v1`.
7. **Accessibility**: every rail nav item gets `role="tab"` + `aria-selected`; the panel region gets `role="tabpanel"`. Keyboard arrow-up/down cycles through autocomplete results; Enter selects.
8. **Tests** (`vitest`):
   - `SearchPanel.test.tsx`: renders, debounces, selects first result on Enter, calls `onSelect`.
   - `recents.test.ts`: dedupe by place_id, cap at 10, newest-first.

## Verify

```bash
cd frontend && pnpm test -- SearchPanel recents && pnpm tsc --noEmit && pnpm build && cd ..
```

Manual smoke: `./run.sh`, open `/maps`. The left rail should render with Search active and the center panel showing the search box. Type an address → autocomplete shows 5 results → click one → pin drops on the map and `PlaceDetailsCard` slides in. Click the blue Directions button → rail switches to Directions and the placeholder panel appears with the To field pre-filled (visibly disabled). Click a nav item with keyboard (arrow keys). Close (X) returns to an empty map view. Reload — the Recents list still shows your selection.

## Commit message

```
feat(maps): Apple Maps-style left rail + place-details card

Reframes /maps into a two-pane layout with a 320px left rail (Search /
Guides / Directions nav + Recents + footer) and a flex map surface.
Search panel (online Nominatim for now; Chunk 5 swaps to offline FTS)
shows up-to-5 autocomplete results; selecting drops a pin and opens
PlaceDetailsCard with title, full address block, and a prominent blue
Directions button. Recents persist to localStorage (cap 10, dedup by
place_id).

Guides and Directions panels ship as disabled placeholders so rail
items aren't dead ends. LayerModeChip / OutOfCoverageBanner from
Chunk 3 stay pinned inside the map surface. No window.confirm.
Keyboard navigation across rail + autocomplete.

Refs docs/roadmap/offline-maps/PLAN.md chunk 4.
```

## Deferrals section (append as you discover)

*(empty)*
