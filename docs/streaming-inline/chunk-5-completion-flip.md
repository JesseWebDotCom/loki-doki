# Chunk 5 — Completion path: flip status in place, no append-on-done

## Goal

Remove the end-of-turn "append a fresh assistant message" path from `ChatPage.tsx`. Instead, on `response_done` / end of `sendChatMessage`, locate the in-progress message (via `inProgressMessageIndexRef` from chunk 2) and mutate its envelope `status` from `streaming` → `complete`, merge in final metadata (sources, `assistant_message_id`, mentioned people, final timestamp if needed), and leave the object in place. Keep `tts.speak()` as a single terminal call. History replay is unchanged.

## Files

Touch:
- `frontend/src/pages/ChatPage.tsx`

Read-only reference:
- `frontend/src/utils/resolveSpokenText.ts` (or wherever `resolveSpokenText` lives — locate via `rg -n "resolveSpokenText" frontend/src`)

## Actions

1. In the end-of-turn block of the `await sendChatMessage(...)` handler (L787–859), find the `setPipeline` that currently builds the final message via `setMessages(msgs => [...msgs, {...}])`.
2. Replace the `[...msgs, {...}]` append with an **in-place update** at `inProgressMessageIndexRef.current` when that ref is non-null:
   - Compute `finalText` (same formula as today — `prev.synthesis?.response?.trim() || prev.streamingResponse?.trim() || fallback`).
   - Compute `liveEnvelope = envelopeRef.current` and ensure the envelope's `status` is `'complete'` (the reducer should already do this on `response_done` — verify).
   - `setMessages(msgs => msgs.map((m, i) => i === inProgressMessageIndexRef.current ? { ...m, content: finalText, envelope: liveEnvelope, sources: prev.synthesis?.sources ?? [], media: prev.synthesis?.media ?? [], pipeline: completedPipeline, mentionedPeople: ..., messageId: ..., confirmations: prev.confirmations, clarification: prev.clarification ?? undefined } : m))`.
3. Leave `tts.speak(\`msg-${inProgressMessageIndexRef.current}\`, spoken)` firing exactly once — same semantics as today (idempotent per messageKey). Use the in-progress index so the messageKey matches the bubble.
4. Fast-lane fallback: when `inProgressMessageIndexRef.current === null` (no `response_init` ever fired), keep the existing `[...msgs, {...}]` append path. Do not regress fast-lane behavior.
5. At turn-start reset, null `inProgressMessageIndexRef.current`.
6. Snapshot-merge convergence: verify (read) that `reduceResponse` on `RESPONSE_SNAPSHOT` adopts the backend-authoritative block content (spoken_text stripped, citations sanitized). If not, leave a `## Blocker` — this chunk depends on the reducer already converging.

## Verify

```
cd frontend && npx tsc --noEmit && npx vitest run src/components/chat/__tests__/ src/pages/__tests__/
```

Manual: `npm run dev`.
- Non-fast-lane turn: only one bubble in the DOM at all times; no swap flash at `response_done`; TTS speaks once.
- Fast-lane turn: behavior unchanged (no `response_init`, single message appended at end).
- History replay: reload the page, verify past turns render identically to today.
- Session-bleed: start a turn in session A, switch to session B mid-flight. No stray bubble in B; return to A and the completed turn is present (loaded from DB).

## Commit message

```
feat(streaming-inline): flip in-place on response_done

End of turn updates the existing in-progress bubble rather than
appending a fresh MessageItem. The envelope transitions streaming →
complete in place; TTS still fires once at completion. Fast-lane turns
(no response_init) still use the original append path so nothing
regresses when the envelope surface is absent.

Refs docs/streaming-inline/PLAN.md chunk 5.
```

## Deferrals

(append-only)
