# Chunk 4 — `ThinkingIndicator` loses `interimText`, keeps phase chrome

## Goal

`ThinkingIndicator` no longer renders streaming prose (the in-progress bubble does). It keeps the phase chip (Warming Up / Planning / Checking Sources / Wrapping Up) and the `PipelineInfoPopover`. Render placement stays **above** the in-progress bubble until `response_done`, then unmounts.

## Files

Touch:
- `frontend/src/components/chat/ThinkingIndicator.tsx`
- `frontend/src/components/chat/ChatWindow.tsx` — this is the **only live** `<ThinkingIndicator />` call site ([ChatWindow.tsx:180–184](../../frontend/src/components/chat/ChatWindow.tsx#L180-L184)). `isThinking` is also derived here ([L132](../../frontend/src/components/chat/ChatWindow.tsx#L132)).
- `frontend/src/components/chat/__tests__/ThinkingIndicator.test.tsx` (if present — update assertions)
- `frontend/src/components/chat/__tests__/ChatWindow.test.tsx` (if present — update assertions)

Read-only reference:
- `frontend/src/components/chat/PipelineInfoPopover.tsx`
- `frontend/src/pages/ChatPage.tsx` — the `pipeline` prop is built here and passed down to `ChatWindow`; the `interimText` prop was removed from ChatPage prior to this plan, so no edits needed here.

## Actions

1. In `ThinkingIndicator.tsx`: remove the `interimText` prop from the `ThinkingIndicatorProps` interface, drop the `cleanInterim`/`cleaned` computation, and delete the block that renders `cleaned` under the phase chip (around L24–34). Keep all other JSX intact.
2. Keep the phase chip + `PipelineInfoPopover` passthrough. Keep the avatar slot.
3. In `ChatWindow.tsx`: remove the `interimText={pipeline?.streamingResponse || undefined}` prop assignment at the `<ThinkingIndicator />` call site ([L183](../../frontend/src/components/chat/ChatWindow.tsx#L183)).
4. Render rule in `ChatWindow.tsx`: the existing `isThinking = pipeline && pipeline.phase !== 'idle'` gate ([L132](../../frontend/src/components/chat/ChatWindow.tsx#L132)) is already correct — non-terminal phases show the chrome, `response_done` flips `phase` to `completed`/`idle` and the indicator unmounts. No change needed beyond dropping `interimText`. If you discover the phase doesn't settle to a terminal value at `response_done`, stop and add a `## Blocker`.
5. Visual placement: `ThinkingIndicator` renders **after** the messages list ([ChatWindow.tsx:179–185](../../frontend/src/components/chat/ChatWindow.tsx#L179-L185)) which — paired with the chunk-2 in-progress bubble already being in `messages` — means the indicator now sits **below** the live bubble in document order. That matches typical streaming-chat UX (chip near the composer, prose above). If the design calls for the chip to sit **above** the live bubble instead, reorder the JSX so `{isThinking && <ThinkingIndicator … />}` renders before the `messages.map(...)` output. Pick whichever direction the design doc dictates; if unclear, keep the current order and note the choice in `## Deferrals`.
6. Do not touch chunk-15 status block — the status chip inside the envelope still feeds TTS `speakStatus` and is orthogonal.

## Verify

```
cd frontend && npx tsc --noEmit && npx vitest run src/components/chat/__tests__/
```

Manual: start a non-fast-lane turn. Confirm the phase chip renders above a live bubble that's already typing in final typography. After `response_done`, chip disappears, bubble stays.

## Commit message

```
refactor(streaming-inline): ThinkingIndicator is phase chrome only

Removes ``interimText`` rendering from ThinkingIndicator — the live
bubble now renders streaming prose directly (chunks 2-3). The indicator
keeps the phase chip + PipelineInfoPopover as lightweight overhead
chrome above the in-progress bubble, and unmounts at response_done.

Refs docs/streaming-inline/PLAN.md chunk 4.
```

## Deferrals

(append-only)
