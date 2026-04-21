# Chunk 22 — Kiosk / Pi display layout polish

## Goal

Bring the rich-response UI to production polish on LokiDoki's real primary display surface — the Pi itself, often a 7" touch display (1024×600) or a car/RV console. Tighten trust-signal language per design doc §22. Tighten mobile / narrow-viewport collapse. Make sure touch targets meet Onyx Material spec. This chunk is all frontend.

## Files

- `frontend/src/components/chat/MessageItem.tsx` — responsive layout polish.
- `frontend/src/components/chat/blocks/BlockShell.tsx` — density tightening for narrow viewports.
- `frontend/src/components/chat/SourceSurface.tsx` — collapse thresholds, touch targets.
- `frontend/src/components/chat/artifact/ArtifactSurface.tsx` — enforce modal presentation on narrow viewports (already specced in Chunk 20; this chunk verifies pixel behavior).
- `frontend/src/components/chat/status_strings.ts` — new. Frontend mirror of backend status strings (read-only; the backend is still the authority) for any UI-only placeholders.
- `frontend/src/components/chat/OfflineTrustChip.tsx` — polish.
- `frontend/src/styles/kiosk.css` — new. Kiosk-specific breakpoints if needed.
- `frontend/src/components/chat/__tests__/kiosk.test.tsx` — new.

Read-only: all prior block / surface components.

## Actions

1. **Breakpoint definitions**:
   - `narrow-touch`: <900px — stack summary → sources → media → follow-ups.
   - `kiosk`: 1024×600 landscape — summary + source-surface side-by-side; media collapses into a horizontal scroll.
   - `desktop`: ≥1280px — full layout with right-side SourceSurface sheet.

2. **Touch targets** — every interactive element hits the Onyx Material minimum (44×44 for touch). Audit: mode toggle buttons, source chips, follow-up chips, artifact version nav, workspace picker. Use shadcn `Button size="sm"` with padding tuned rather than naked links.

3. **Summary-and-source fit at 1024×600** — the design doc §21.5 requires this. Test viewport exactly that size; assert summary + source surface both visible without scroll on a two-skill turn.

4. **Density knobs**:
   - At `narrow-touch`, block headers collapse to a single line; source snippets truncate at 80 chars.
   - At `kiosk`, block gaps tighten; status block is inline with the summary header.
   - At `desktop`, defaults.

5. **Trust-signal polish** — refine the status strings (keep them backend-authoritative; Chunk 15 already shipped the table). Review the full list of strings for the design doc §22 "Good / Bad" axis. Anywhere the UI still leaks "execute phase" / "capability resolution" / "prompt assembly", replace with the human version.

6. **Offline chip visibility** — always visible when the envelope flag is set, never obscured by density. On kiosk, place inline with the message header, not in a corner.

7. **Mode toggle on narrow** — the four-option toggle may not fit horizontally at 360px wide. Collapse to a shadcn `Select` below a certain breakpoint, not a disappearing menu.

8. **Pipeline popover on kiosk** — the dev-only technical popover (`PipelineInfoPopover`) should be dismissible and never block the summary. Confirm its touch dismiss behavior.

9. **Tests** (`kiosk.test.tsx`):
   - Render `MessageItem` at 1024×600; assert summary + sources both in viewport.
   - Render at 360×640; assert block stack order and that every interactive element has ≥44×44 bounding box.
   - Render artifact at narrow viewport; assert it's a dialog, not a side sheet.
   - Grep invariant: `rg -n "window\\.(confirm|alert|prompt)\\(" frontend/src/` returns nothing.

## Verify

```
npm --prefix frontend run test -- kiosk && npm --prefix frontend run build && npm --prefix frontend run lint
```

All tests pass. Build succeeds. Lint clean. Manual: run the dev server, resize to 1024×600, run through a handful of turns covering direct / standard / rich / deep / artifact — every turn respects the layout contract.

## Commit message

```
polish(chat): kiosk / Pi display layout + trust-signal refinement

Tighten responsive layout for the 1024×600 kiosk target: summary +
source surface fit without scroll, density knobs per breakpoint,
touch targets meet Onyx Material 44px spec. Mode toggle collapses
to a select at narrow widths. Artifact renders as a dialog on
narrow, sheet on wide. Trust-signal strings reviewed against design
doc §22 good/bad axis; no internal jargon leaks into the UI.

Grep invariant enforces no window.confirm / alert / prompt usage.

Refs docs/rich-response/PLAN.md chunk 22.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
