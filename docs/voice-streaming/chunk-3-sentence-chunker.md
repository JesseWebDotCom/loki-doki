# Chunk 3 — Frontend sentence/clause chunker on `block_patch`

## Goal

Frontend module that consumes summary-block deltas (from `block_patch`) and emits closed utterances on sentence/clause boundaries, with markdown/citation stripping. Pure logic in this chunk — no playback yet (that's chunk 4). Must be robust to split-surrogate pairs, mid-word chunks, code fences, markdown list markers.

## Files

Touch (create):
- `frontend/src/utils/sentenceChunker.ts`
- `frontend/src/utils/__tests__/sentenceChunker.test.ts`

Read-only reference:
- The summary block delta shape in `block_patch` events — inspect via `rg -n "block_patch" frontend/src/utils`
- `docs/voice-streaming/DESIGN.md` (chunker contract)

## Actions

1. Export a `createSentenceChunker()` factory returning `{ push(delta: string): Utterance[], flush(): Utterance[] }`. `Utterance = { text: string; spokenText: string; index: number }` where `spokenText` is the markdown-stripped citation-stripped form.
2. `push(delta)` appends to an internal buffer; scans from the previous cursor; emits any sentences whose terminator is observed. A terminator is `[.!?]` followed by whitespace OR end-of-buffer-with-some-lookahead-margin (don't emit on EOF alone — wait until `flush()` or next push confirms).
3. Clause fallback: if the running buffer since last emission exceeds 120 chars and contains `,` or `;`, emit at the last such boundary.
4. Strip before emitting:
   - Citation markers `[src:\d+]` and `[\d+]` refs.
   - Markdown emphasis (`**`, `*`, `_`, `` ` ``), but keep the inner text.
   - Heading prefixes (`^#+ `).
   - List bullets (`^(- |\* |\d+\. )`) at emit time.
5. Suppress entirely: content inside fenced code blocks (```` ``` ````). Track `inCodeFence` state across deltas.
6. `flush()` emits any remaining buffered content as the last utterance (called when `response_done` arrives).
7. `index` monotonically increments per chunker instance so consumers can map utterances to queue slots.
8. Pure TypeScript, no React, no DOM. Full unit-test coverage:
   - Single sentence delivered in one push.
   - Single sentence split across 3 pushes (char-by-char edge case).
   - Multi-sentence buffer produces multiple utterances in one push.
   - Citation stripping, markdown stripping.
   - Code fence suppression.
   - Run-on sentence > 120 chars emits on comma.
   - Surrogate pair safety (🎉 across two chunks).
   - `flush()` emits trailing buffer with no terminator.

## Verify

```
cd frontend && npx vitest run src/utils/__tests__/sentenceChunker.test.ts && npx tsc --noEmit
```

## Commit message

```
feat(voice-streaming): sentence chunker for streaming summary text

Pure TS chunker consumes block_patch deltas and emits closed
utterances on sentence/clause boundaries with citation markers,
markdown emphasis, list bullets, and heading prefixes stripped;
suppresses fenced code blocks entirely. Pacing + playback arrive in
chunk 4.

Refs docs/voice-streaming/PLAN.md chunk 3.
```

## Deferrals

(append-only)
