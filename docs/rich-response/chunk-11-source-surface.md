# Chunk 11 — SourceSurface + structured citations + offline trust chip

## Goal

Make sources a first-class, persistent answer region — not a footer appendage. Introduce `SourceSurface` as the side/drawer view of `envelope.source_surface`, expand the `Source` model to carry real metadata, and add the **offline trust chip** that appears when a skill needed network data but the device was offline.

## Files

- `frontend/src/components/chat/SourceSurface.tsx` — new. Replaces `SourcesPanel.tsx` as the primary drawer; `SourcesPanel.tsx` is deleted only after the migration compiles.
- `frontend/src/components/chat/SourceCard.tsx` — new. Richer than `SourceChip` — title, snippet, kind, date, relevance, author.
- `frontend/src/components/chat/OfflineTrustChip.tsx` — new.
- `frontend/src/components/chat/blocks/SourcesBlock.tsx` — edit to use the richer `Source` metadata (title + snippet + date when present) instead of only label/URL.
- `frontend/src/components/chat/MessageItem.tsx` — mount `SourceSurface` when `envelope.source_surface` is non-empty; mount `OfflineTrustChip` when the envelope reports offline degradation.
- `lokidoki/orchestrator/response/planner.py` — set an `offline_degraded: bool` flag on the envelope when any skill failed with `reason="offline"`.
- `lokidoki/orchestrator/response/envelope.py` — add `offline_degraded: bool = False` to `ResponseEnvelope`.
- `frontend/src/lib/response-types.ts` — mirror the new field.
- `tests/unit/test_response_offline.py` — new.
- `frontend/src/components/chat/__tests__/source-surface.test.tsx` — new.

Read-only: Chunks 1, 6, 8, 10.

## Actions

1. **`SourceCard`** — shadcn/ui `Card` with:
   - Favicon (reuse `faviconCache.ts`; if offline and no cached favicon, fall back to a generic icon — no network fetch).
   - Title (required).
   - URL hostname as a secondary line.
   - Snippet (truncated to ~140 chars).
   - `kind` label (web / doc / memory / skill / local).
   - Optional `published_at` and `author`.
   - Click: opens the URL in a new tab via the app's existing external-link handler; NEVER a fetch.

2. **`SourceSurface`** — side drawer on ≥1024px, modal sheet on narrower. shadcn/ui `Sheet`. Lists `SourceCard`s from `envelope.source_surface`. Includes a "Use this source next turn" affordance that writes into the next turn's input context (the plumbing for next-turn selection is minimal — add a local state flag; the actual "use this source next" semantics lands with workspace/mode work).

3. **`SourcesBlock` upgrade** — render at most 4 inline `SourceChip` items; "View all N sources" opens `SourceSurface`. The block is *a view into* `source_surface`; both read from the same envelope field.

4. **`OfflineTrustChip`** — mounted at the top of the message shell when `envelope.offline_degraded` is true. Text: `"Offline — using local knowledge"`. Style: muted shadcn `Badge` with an offline lucide icon.

5. **Backend flag** — in the synthesis phase, after aggregating executions, set `envelope.offline_degraded = True` if any execution failed with a recognizable offline reason (network unreachable, DNS failure, timeout to an external URL). The exact classification can piggyback on `MechanismResult.error` string inspection for now; tighten later if noisy.

6. **Deletion of `SourcesPanel.tsx`**:
   - Grep for usages: `rg -n "SourcesPanel" frontend/src/`.
   - Migrate every consumer to `SourceSurface`.
   - Delete `SourcesPanel.tsx` only after the build is green.

7. **Offline safety on source assets**. In `SourceCard`:
   - `img` tags with remote URLs are NOT allowed at runtime. Favicon fetches go through `faviconCache.ts`, which already has an offline-safe fallback — verify that before shipping.
   - Source URLs themselves are allowed as link targets (the user clicks out), but no auto-fetch, no preview-on-hover.

8. **Tests**:
   - Backend: a turn with two successful + one offline-failed execution sets `offline_degraded = True`; all-successful sets `False`.
   - Frontend: `OfflineTrustChip` renders only when the envelope flag is true.
   - `SourceSurface` with 10 sources renders 10 `SourceCard`s and collapses correctly on narrow viewports.

## Verify

```
pytest tests/unit/test_response_offline.py tests/unit/test_phase_synthesis.py -v && npm --prefix frontend run test -- source-surface && npm --prefix frontend run build
```

All tests pass. Manual: disconnect the test machine from the network, send a "latest news about X" query → the offline chip appears and the summary falls back to local knowledge without trying to hit the network.

## Commit message

```
feat(chat): SourceSurface + structured citations + offline trust chip

Sources are now a first-class answer region. SourceSurface renders
in a side drawer (wide) or modal sheet (narrow), showing richer
metadata (snippet, kind, date, author) via SourceCard. The inline
SourcesBlock shows up to 4 chips with a "View all" escape to the
surface.

OfflineTrustChip surfaces when a skill degraded due to no network,
driven by envelope.offline_degraded.

Refs docs/rich-response/PLAN.md chunk 11.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
