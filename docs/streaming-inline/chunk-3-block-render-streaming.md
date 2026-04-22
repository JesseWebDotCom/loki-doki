# Chunk 3 — Block renderers handle `streaming` envelope + `partial` block state

## Goal

With an in-progress `MessageItem` bubble rendering from `response_init` (chunk 2), every block renderer must degrade gracefully for `envelope.status === 'streaming'` and `block.state === 'partial' | 'pending' | 'omitted'`. The summary block needs to render its `content` as it grows; sources/media/meta blocks should hide or show a skeleton until `state === 'ready'`. No flicker as blocks transition.

## Files

Touch:
- `frontend/src/components/chat/MessageItem.tsx`
- `frontend/src/components/chat/blocks/SummaryBlock.tsx`
- `frontend/src/components/chat/blocks/KeyFactsBlock.tsx`
- `frontend/src/components/chat/blocks/StepsBlock.tsx`
- `frontend/src/components/chat/blocks/ComparisonBlock.tsx` (if present — skip if absent)
- `frontend/src/components/chat/blocks/SourcesBlock.tsx` (if present — locate via `rg -n "SourcesBlock" frontend/src`)
- `frontend/src/components/chat/blocks/MediaBlock.tsx` (if present)
- `frontend/src/components/chat/blocks/FollowUpsBlock.tsx`

Read-only reference:
- The `Block` / `BlockState` / `ResponseEnvelope` types (locate via `rg -n "type Block =\\|BlockState\\|ResponseEnvelope" frontend/src/types`)

## Actions

1. In `MessageItem.tsx` `assistantBlocks` memo (L132–160): when `envelope` present, pass through `envelope.blocks` unchanged (same as today). No changes here — rendering decisions move into each block component.
2. In `SummaryBlock.tsx`: render `content` (or whatever the content field is named) whenever it's a non-empty string, regardless of `state`. Keep existing markdown + citation-chip rendering. Add a trailing caret cursor (`<span class="opacity-50 animate-pulse">▍</span>`) only while `envelope.status === 'streaming' && block.state !== 'ready'`. Use shadcn/tailwind tokens — no raw HTML styling.
3. In `KeyFactsBlock` / `StepsBlock` / `ComparisonBlock`: if `block.state === 'pending' | 'partial'` AND array is empty, render a shadcn `Skeleton` placeholder (3 lines, respect Onyx Material). If array has items, render normally; items can grow in place.
4. In `SourcesBlock` / `MediaBlock` / `FollowUpsBlock`: render nothing unless `block.state === 'ready'`. (Design matches snapshot-merge invariant — sources only appear when backend authoritative.)
5. `MessageItem.tsx` already passes `envelope?.status` downstream for `DeepWorkFrame` (L343). Extend the pass-through so each block renderer receives `envelopeStatus: 'streaming' | 'complete'` as a prop when useful (don't drill if unused).
6. Do not change the legacy non-envelope fallback branch (L137–159) — fast-lane turns still use it.

## Verify

```
cd frontend && npx tsc --noEmit && npx vitest run src/components/chat/__tests__/
```

Manual: `npm run dev`. Start a chat. While a non-fast-lane turn is streaming, inspect the bubble mid-stream — prose should be in the final typography (not dim/small), no source chips until ready, caret cursor visible at the tail. No layout shift when sources arrive.

## Commit message

```
feat(streaming-inline): block renderers handle streaming envelope

Summary renders progressively during ``envelope.status === 'streaming'``
with a trailing caret; key-facts/steps/comparison show Onyx Skeletons
until populated; sources/media/follow-ups stay hidden until
``block.state === 'ready'`` so we never flash stale/partial citations.

Refs docs/streaming-inline/PLAN.md chunk 3.
```

## Deferrals

(append-only)
