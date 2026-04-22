# Chunk 20 — ArtifactSurface UI + version navigation + export RPC

## Goal

Build the user-visible artifact surface on top of Chunk 19's secured foundation. Dedicated right-side surface on wide screens, modal on narrow. Version navigation (prev / next / latest). Copy + export actions via the typed RPC. Narrow planner triggering so artifacts don't fire for ordinary responses.

## Files

- `frontend/src/components/chat/artifact/ArtifactSurface.tsx` — new. The side/modal container.
- `frontend/src/components/chat/artifact/ArtifactVersionNav.tsx` — new.
- `frontend/src/components/chat/artifact/ArtifactExportMenu.tsx` — new.
- `frontend/src/components/chat/blocks/ArtifactPreviewBlock.tsx` — new. Inline teaser that opens the surface.
- `frontend/src/components/chat/blocks/index.ts` — register the preview renderer.
- `frontend/src/components/chat/MessageItem.tsx` — host the dedicated artifact surface and preview-open state.
- `frontend/src/lib/response-types.ts` — typed artifact surface payload mirrored from the backend envelope.
- `lokidoki/orchestrator/response/blocks.py` — add `artifact_preview` block type.
- `lokidoki/orchestrator/response/planner.py` — allocate `artifact_preview` + populate `envelope.artifact_surface` when `mode == "artifact"`.
- `lokidoki/orchestrator/core/pipeline_phases.py` — build the artifact surface payload + preview item during envelope assembly.
- `lokidoki/orchestrator/response/artifact_trigger.py` — new. `should_use_artifact_mode(decomposition, user_override)` — narrow decision that only returns true for explicit artifact asks.
- `tests/unit/test_artifact_trigger.py` — new.
- `tests/unit/test_response_envelope.py` — round-trip coverage updated for the new block family.
- `tests/unit/test_response_mode.py` — artifact planner shape assertions.
- `frontend/src/components/chat/__tests__/artifact-surface.test.tsx` — new.

Read-only: Chunk 19 sandbox, Chunk 12 mode derivation.

## Actions

1. **Trigger rules** (`artifact_trigger.py`):
   - Return `True` only when `user_override == "artifact"` OR the decomposer explicitly flagged an artifact-class intent (e.g. `intent` value corresponding to "generate an interactive visualization" — hook into decomposer's existing `intent` signal; no regex over user text).
   - If the current profile is `pi_cpu` and the user didn't explicitly opt in, return `False` — Pi artifact generation is expensive; explicit opt-in only.
   - Default is `False`. Errors caution on the side of NOT triggering artifact mode.

2. **`ArtifactSurface`** — a shadcn/ui `Sheet` or a `Dialog` depending on viewport:
   - Right-side sheet on ≥1280px.
   - Modal dialog on narrower (per §21.5 kiosk rule).
   - Header: title + `ArtifactVersionNav` + export menu + close.
   - Body: Chunk 19's `SandboxedFrame` rendering `artifact.versions[selectedVersion].content`.
   - Footer: subtle note "Runs sandboxed and offline."

3. **Version navigation** (`ArtifactVersionNav.tsx`):
   - ‹ / latest / › buttons.
   - Version chip ("v3 of 5") with a dropdown for direct selection.
   - "Revert to this version" shadcn `ConfirmDialog` (never `window.confirm`) creates a new version N+1 whose content equals the older version — preserves the immutability invariant from Chunk 19.

4. **Export menu** (`ArtifactExportMenu.tsx`):
   - "Copy HTML" → copies `content` to clipboard.
   - "Save as .html" / "Save as .svg" → triggers download via a `Blob`; no network.
   - "Copy sandbox URL" — intentionally omitted; there is no sharable URL (offline-first).

5. **Inline preview block** (`ArtifactPreviewBlock.tsx`):
   - A compact card in the message shell showing the artifact title + a static thumbnail (SVG screenshot or first N chars of content as a text preview — no live render inline; the `SandboxedFrame` only mounts inside `ArtifactSurface`).
   - Click opens the surface.

6. **Planner wiring** — when `envelope.mode == "artifact"`:
   - Summary block remains (short supervisory text).
   - `artifact_preview` block is allocated.
   - `envelope.artifact_surface` is populated with the artifact id + title + current version.
   - All other block types are suppressed (sources may still appear if the artifact cited any).

7. **Offline invariants** (enforced here, again):
   - The sandbox and the export paths never touch the network.
   - Thumbnails are locally rendered from content, not fetched.
   - Version history reads purely from the local SQLite store.

8. **Tests**:
   - Artifact trigger: default false; explicit override true; pi_cpu rejects auto-trigger.
   - Surface renders on wide viewport as a sheet; on narrow as a dialog.
   - Version nav cycles through versions; revert creates version N+1 with the reverted content.
   - Export downloads a `.html` / `.svg` file from the blob; no `fetch` called.
   - Preview block click opens the surface and mounts `SandboxedFrame` exactly once.

## Verify

```
pytest tests/unit/test_artifact_trigger.py -v && npm --prefix frontend run test -- artifact-surface && npm --prefix frontend run build
```

All tests pass. Manual (mac dev): `/artifact make a one-page HTML clock` (or whatever command fires artifact mode) → the surface appears with the sandboxed output; copy/export work; revert creates a new version; network tab shows zero requests during rendering.

## Commit message

```
feat(artifacts): ArtifactSurface + version nav + export RPC

User-visible artifact UI on top of chunk 19's security foundation:
a side sheet (wide) / modal (narrow) surface rendering the
SandboxedFrame, version navigation with revert-creates-new-version
semantics, copy/save export via local blob (never network), and an
inline preview block.

Planner triggers artifact mode only on explicit opt-in; pi_cpu
never auto-triggers. Offline invariants preserved end-to-end.

Refs docs/rich-response/PLAN.md chunk 20.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
