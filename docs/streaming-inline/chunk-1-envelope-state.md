# Chunk 1 — Mirror envelope to React state

## Goal

Today the live envelope lives only in `envelopeRef` ([`ChatPage.tsx:304`](../../frontend/src/pages/ChatPage.tsx#L304)), so React never re-renders on `block_patch`. Add a state mirror so any component bound to the live envelope re-renders on every delta. No in-progress message yet — that's chunk 2. Fast-lane turns and history replay must be unaffected.

## Files

Touch:
- `frontend/src/pages/ChatPage.tsx`

Read-only reference:
- `frontend/src/utils/responseReducer.ts` (or wherever `reduceResponse` lives — locate via `rg -n "reduceResponse" frontend/src`)
- `frontend/src/components/chat/MessageItem.tsx`

## Actions

1. Next to `envelopeRef` (L304), add `const [liveEnvelope, setLiveEnvelope] = useState<ResponseEnvelope | undefined>(undefined)`.
2. In the `isResponseEvent(event)` branch (L628–674), immediately after `envelopeRef.current = reduceResponse(envelopeRef.current, event)`, call `setLiveEnvelope(envelopeRef.current)`.
3. At turn-start reset where `envelopeRef.current = undefined` is assigned (find near L770), also call `setLiveEnvelope(undefined)`.
4. At end-of-turn, after the existing `envelopeRef.current = undefined` clear (L823), also `setLiveEnvelope(undefined)` so the state tracks the ref.
5. Do **not** consume `liveEnvelope` yet. No rendering changes. This chunk only wires the state mirror.

## Verify

```
cd frontend && npx tsc --noEmit && npx vitest run src/components/chat/__tests__/
```

Manual sanity: `npm run dev` and confirm that a normal chat turn still produces a bubble identical to today (the state mirror has zero visible effect in this chunk).

## Commit message

```
feat(streaming-inline): mirror live envelope into React state

Adds a ``liveEnvelope`` state alongside ``envelopeRef`` in ChatPage so
downstream consumers can re-render on every ``block_patch`` without
reaching into a ref. No rendering changes yet — chunks 2+ bind UI to
this state.

Refs docs/streaming-inline/PLAN.md chunk 1.
```

## Deferrals

(append-only)

## Blocker

`cd frontend && npx tsc --noEmit && npx vitest run src/components/chat/__tests__/`
fails on an existing test outside this chunk's allowed file scope:
`src/components/chat/__tests__/MessageItem.test.tsx > renders citation chips as title-dash-source labels...`
expects `Nintendo Switch 2 - Wikipedia`, but the current rendered chip text is `Wikipedia`.
