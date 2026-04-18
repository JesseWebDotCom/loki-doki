# Chunk 7 — Directions panel UI + route alternatives + turn-by-turn

## Goal

Replace the Directions placeholder from Chunk 4 with a full Apple Maps–style Directions panel: car / walk / bike mode toggle, two reorderable From / To pills with red pin badges + drag-reorder handles, an **Add Stop** affordance, **Now** (depart-time) and **Avoid** (highways / tolls / ferries) dropdowns, and a scrollable list of route alternatives. Each alternative shows `NN min` / `ETA HH:MM AM/PM` / `N miles` and a **Fastest** badge on the best. The alternatives are also drawn on the map as overlaid polylines with a time-badge label near each route; the selected one is highlighted in Material Purple, the others dimmed. A subsequent click on an alternative selects it; clicking an on-map route label does the same. The selected route also populates a scrollable **turn-by-turn list** (Valhalla's `maneuver.instruction` strings); clicking an instruction zooms the map to that maneuver's geometry. One-shot TTS readout button ("Read directions") passes the joined instruction text through the existing synthesis path.

This chunk is UI-only against the Chunk-6 backend. No new routing logic.

## Files

- `frontend/src/pages/maps/panels/DirectionsPanel.tsx` — rewrite the placeholder into the full panel.
- `frontend/src/pages/maps/panels/DirectionsPanel.types.ts` — new: `DirectionsForm`, `ModeId`, `RouteAlt`, `Maneuver`.
- `frontend/src/pages/maps/panels/RouteAltCard.tsx` — new: one alternative card (highlighted / dimmed / selected states).
- `frontend/src/pages/maps/panels/TurnByTurnList.tsx` — new: scrollable instruction list, clickable rows.
- `frontend/src/pages/maps/panels/AvoidMenu.tsx` — new: shadcn `DropdownMenu` over a checkbox trio.
- `frontend/src/pages/maps/panels/DepartMenu.tsx` — new: shadcn `DropdownMenu` with `Now` / `Leave at…` / `Arrive by…` options + a lightweight time picker (deferred full UI — only "Now" is wired in v1, the other two surface a "Coming soon" state).
- `frontend/src/pages/maps/route-layer.ts` — new: MapLibre source/layer helpers to render alternatives as GeoJSON polylines with the time-badge `symbol` layer, plus hover/selected state.
- `frontend/src/pages/maps/use-directions.ts` — new: hook that owns form state + fetches `/api/v1/maps/route` with the right body shape; exposes `alternates`, `selected`, `select(idx)`, `isLoading`, `error`.
- `frontend/src/pages/MapsPage.tsx` — edit: when `activePanel === "directions"`, render `DirectionsPanel`; pass `selectedPlace` from PlaceDetailsCard into the `To` field.
- `frontend/src/pages/maps/panels/DirectionsPanel.test.tsx` — new vitest.
- `frontend/src/pages/maps/route-layer.test.ts` — new vitest.

Read-only: `lokidoki/api/routes/maps.py` (route payload shape); `frontend/src/pages/maps/recents.ts`; `frontend/src/components/ui/ConfirmDialog.tsx`.

## Actions

### Form + mode

1. **Mode toggle** at top: three-segment icon chip (car / walk / bike). shadcn `ToggleGroup`, Lucide icons. Selected mode background Elevation-2 + Material Purple accent (matches the Apple reference). Updates `profile` in the API body: `auto` / `pedestrian` / `bicycle`.
2. **From / To pills**: two rows with a red pin icon on the left, a text input, and a drag-reorder handle on the right. Drag swaps them. The inputs share the `SearchPanel` autocomplete component (extract the autocomplete dropdown out of `SearchPanel` into a shared `PlaceAutocomplete` — one-line file split if needed).
3. **Add Stop** ghost button below the To pill — inserts a third row. Waypoints cap at 5 for v1. Rows remain reorderable; the first is always origin, the last is always destination.
4. **Now / Avoid** dropdowns side-by-side, shadcn `DropdownMenu` anchored to pill buttons matching the reference. "Now" ships `Now` as the only active option; `Leave at…` / `Arrive by…` are greyed-out placeholders. "Avoid" ships `Highways`, `Tolls`, `Ferries` checkboxes.

### Route fetch + alternates

5. **`use-directions.ts`**: debounces form changes (250 ms), calls `POST /api/v1/maps/route` with `alternates: 3`. On success, dispatches to `route-layer.ts` to draw polylines (selected: `#A855F7` 5 px, alternates: `#888` 3 px + 0.5 opacity, time-badge symbol layer positioned at each route's midpoint). On error → inline red banner with retry. On `offline: true` from backend (no coverage + offline) → greyed panel with the same out-of-coverage banner the tile layer uses.
6. **`RouteAltCard.tsx`**: title = `{NN} min`; second line = `{ETA HH:MM AM/PM} · {N} miles`; third line = `{Fastest}` badge for the best. Card background Elevation-1, selected card Elevation-3 + purple left-border. Clicking a card sets the selection; clicking the on-map time-badge does the same through the shared state.
7. **Turn-by-turn list**: below the alternates, scrollable. Each row shows a maneuver glyph (translate Valhalla's `type` to a Lucide icon — `turn-left`, `turn-right`, `continue`, `merge`, etc.), the `instruction` string, and the maneuver's `length_m` formatted as imperial or metric per user locale setting. Clicking a row fits the map to that maneuver's geometry.

### Speak directions

8. **"Read directions" button** at the bottom of the panel. Joins `instructions_text` with commas, sends a single POST to the existing synthesis endpoint (`/api/v1/voice/synthesize` or whatever the current TTS route is — grep `synthesize` in `lokidoki/api/routes/` to confirm before wiring). Streams the resulting audio through the existing audio player. Nothing fancy — no live nav — but it proves end-to-end offline-to-speech works.

### Recents + deep links

9. **Directions recents**: `recents.ts` gains a `pushDirectionsRecent({from, to, mode})` function; Directions panel shows a `Recent directions` section at the bottom. Cap 10.
10. **Deep links**: `/maps?from=...&to=...&mode=auto` auto-opens the Directions panel with the form pre-filled and auto-fetches the route. Enables the Claude-assistant skill → UI handoff ("show me directions to the pharmacy" → the skill composes this URL and opens it in a new pane).

### Tests

11. `DirectionsPanel.test.tsx`:
    - Renders with a `to` pre-filled from props.
    - Swaps From / To on drag handle swap.
    - Mode toggle updates the request body (mock fetch).
    - Empty alternatives renders an error state.
12. `route-layer.test.ts`:
    - Draws 3 polylines in correct `paint` colors.
    - Selection toggles the purple highlight without remounting the source.

## Verify

```bash
cd frontend && pnpm test -- DirectionsPanel route-layer && pnpm tsc --noEmit && pnpm build && cd ..
```

Manual smoke: with CT installed and network off, open `/maps`, search `150 Stiles St Milford`, click Directions on the place card. From field auto-fills with "My location" (if geolocation granted) or stays blank. Type `500 Nyala Farms Rd Westport` as From. Three alternatives appear both in the list and drawn on the map with "26 min Fastest", "27 min", "38 min" badges — matches the reference screenshots. Toggle to walk → shorter, slower alternatives. Avoid → Highways ON → route recomputes. Click a turn-by-turn row → map zooms to that maneuver. Click "Read directions" → Piper speaks the joined instruction text.

## Commit message

```
feat(maps): Directions panel with alternates, avoid, and turn-by-turn

Rewrites the Chunk-4 placeholder into a full Apple Maps-style
Directions panel: car/walk/bike toggle, draggable From/To pills
sharing the SearchPanel autocomplete, Add Stop, Now/Avoid dropdowns,
and a list of up to three route alternatives. Alternatives also
render on the map as overlaid GeoJSON polylines with time-badge
labels; selecting in either place highlights the chosen route in
Material Purple. A scrollable turn-by-turn list reads Valhalla's
instruction strings and zooms the map on row click. A "Read
directions" button pipes the joined text through the existing
synthesis path for a one-shot TTS readout (full voice navigation
remains a later roadmap item).

Deep link /maps?from=&to=&mode=auto pre-fills the panel, enabling
skill→UI handoff. No window.confirm anywhere.

Refs docs/roadmap/offline-maps/PLAN.md chunk 7.
```

## Deferrals section (append as you discover)

- **Live voice navigation** (rerouting on GPS, continuous spoken instructions) — explicit non-goal in PLAN.md.
- **`Leave at…` / `Arrive by…`** depart-time options — UI ships disabled; backend work to pass a `date_time` into Valhalla is a follow-up.
- **Transit directions** — Valhalla supports GTFS-ingested transit but we haven't downloaded any GTFS per region. Future chunk.
