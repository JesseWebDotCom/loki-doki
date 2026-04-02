# LokiDoki Absorption Surface

This folder defines the neutral integration surface for moving the lab into `loki-doki`.

## Purpose

- Avoid introducing a permanent `LokiAnimator` product surface or naming inside `loki-doki`.
- Make the replacement scope explicit for the runtime, editor, and repository migration work.
- Give the eventual `loki-doki` migration a single import surface for the pieces that are being absorbed.

## Files

- `contracts.ts`: integration contracts, package manifest shape, and event bridge mapping
- `migrationPlan.ts`: workstreams, lab decommission gates, and repository migration policy
- `CharacterRuntimeProviders.tsx`: neutral provider wrapper for the migratable runtime stack
- `CharacterWorkspace.tsx`: neutral stage + editor workspace composition for embedding into `loki-doki`
- `appTheme.css`: animator visual language extracted as a reusable app theme layer
- `index.ts`: barrel exports for the reusable runtime/editor/providers

## Boundary rule

- `src/lab/*` is standalone-harness code only.
- `src/integration/*` is the migration-facing surface intended to move into `loki-doki`.

## Current intent

The permanent destination is:

- `loki-doki`: runtime, character editor/creator, validation, and publishing
- `loki-doki-characters`: validated exported character packages
- `loki-doki-animator`: temporary lab only
