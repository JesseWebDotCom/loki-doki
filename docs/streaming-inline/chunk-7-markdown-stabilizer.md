# Chunk 7 — Streaming markdown stabilizer

## Goal

With the live bubble rendering through `ReactMarkdown` from the first `block_patch`, partial deltas mid-stream produce visible garbage: `**hello` with no closer shows literal asterisks, `` `code `` shows stray backticks, ` ``` ` with no closer breaks the rest of the message, `[text](ht` shows a broken link, trailing `[src:` shows raw bracket text until the citation number and `]` land. Today's dim-raw-text indicator sidestepped this by not running markdown. Now we need a **stabilizer**: a pure function that pre-processes the live buffer each render so unclosed delimiters are virtually closed for display, without mutating the underlying envelope content. Snapshot convergence must still win — when `response_snapshot` arrives, the authoritative content renders normally.

## Files

Touch:
- `frontend/src/utils/markdownStabilizer.ts` (new)
- `frontend/src/utils/__tests__/markdownStabilizer.test.ts` (new)
- `frontend/src/components/chat/blocks/SummaryBlock.tsx` (apply stabilizer when `envelope.status === 'streaming'` and block `state !== 'ready'`)
- `frontend/src/components/chat/__tests__/SummaryBlock.test.tsx` (extend — or the test file created in chunk 3)

Read-only reference:
- `frontend/src/components/chat/MessageItem.tsx` (`ReactMarkdown` configuration + citation-link handler at the `a:` renderer — the stabilizer must preserve `[src:N]` references that HAVE closed so the chunk-11 source chip still renders)

## Actions

1. Create `markdownStabilizer.ts` exporting a single pure function:

   ```ts
   export function stabilizeStreamingMarkdown(raw: string): string
   ```

   No React, no DOM. Pure string → string. Behavior per delimiter family below. Order matters — do them in the order listed so earlier cleanups don't re-open later ones.

2. **Trailing incomplete citation.** Trim any trailing `[src:` or `[src:<digits>` with no closing `]` — elide from the render string until the closer arrives. Also trim a bare trailing `[` if it's the last char.

3. **Trailing incomplete link.** If the tail ends in `[…]` followed by `(` with no matching `)`, elide from the `[` onward until the link closes. Example: `See [Luke](ht` → rendered as `See ` during streaming; snaps in whole once `)` arrives.

4. **Unclosed fenced code block.** Count triple-backtick fences (` ``` `). If odd, append a virtual closing fence on its own line so the rest of the message doesn't render inside the open fence. This preserves the in-progress code as styled code; the cursor caret from chunk 3 still trails outside the fence.

5. **Unclosed inline code.** Count single backticks (after stripping fenced blocks). If odd, append a virtual closing backtick. Edge case: backticks inside a fenced block don't count — do this AFTER fence handling so fence body is already neutralized.

6. **Unclosed bold / italic.**
   - Count `**` pairs (after stripping code). If odd-occurrence leaves a dangling `**`, append `**`.
   - Count single `*` NOT part of a `**` pair. If odd, append `*`.
   - Count `_` used as emphasis (word-boundary `_…_`). Conservative: skip `_` handling if it risks interfering with identifiers like `snake_case`. Only close a trailing `_` if it sits at a word boundary with an opener upstream.

7. **Unclosed list marker.** If the buffer ends with a bare list marker (`- ` / `* ` / `\d+\. ` with no following text on that line), leave it alone — `ReactMarkdown` renders a bullet placeholder which is acceptable. Don't try to close anything here.

8. **Unclosed table.** Tables mid-stream look bad but are rare in our outputs. Skip table stabilization this chunk; note in `## Deferrals` if a real case shows up.

9. In `SummaryBlock.tsx`: import `stabilizeStreamingMarkdown`. When `envelope.status === 'streaming'` **and** `block.state !== 'ready'`, pass `stabilizeStreamingMarkdown(content)` as the markdown source instead of `content`. In every other case (fast-lane, history replay, final post-snapshot render), pass `content` untouched — stabilizer must never run against authoritative content.

10. Preserve the trailing caret from chunk 3 — the caret renders AFTER the stabilized output, so virtual closers appear invisibly before the caret.

11. Do NOT store the stabilized string back into the envelope. Envelope content stays authoritative; stabilization is a render-only transform.

12. Unit tests in `markdownStabilizer.test.ts`:
    - Closed content is returned verbatim (no-op on stable input).
    - `**hello` → `**hello**`
    - `*em` → `*em*`
    - `` `code `` → `` `code` ``
    - Odd fence: ` ``` \nconst x = 1` → appends `\n``` `
    - Fenced + unclosed inner backtick: backtick inside fence does NOT trigger inline-code closer.
    - Trailing `[src:` → elided
    - Trailing `[src:12` → elided
    - Closed `[src:1]` → preserved verbatim (chunk-11 chip still renders)
    - Trailing `[Luke Skywalker](ht` → elides from `[` onward
    - Closed `[Luke](https://x)` → preserved verbatim
    - Snake_case identifier `foo_bar_baz` → not mutated (no dangling `_` close)
    - Idempotent: `stabilizeStreamingMarkdown(stabilizeStreamingMarkdown(x)) === stabilizeStreamingMarkdown(x)` for a sample of streaming inputs.

13. Component test in `SummaryBlock.test.tsx`:
    - Streaming envelope + content `"This is **bold"` → rendered DOM contains `<strong>bold</strong>`, not literal asterisks.
    - Streaming envelope + content `"See [src:"` → rendered DOM does not contain `[src:` as visible text.
    - `status: 'complete'` + content `"Unbalanced **"` → renders verbatim (stabilizer NOT applied); verifies the authoritative content path.
    - Caret `▍` still appears after the stabilized prose while streaming.

## Verify

```
cd frontend && npx tsc --noEmit && npx vitest run src/utils/__tests__/markdownStabilizer.test.ts src/components/chat/__tests__/
```

Manual smoke: `npm run dev`. Non-fast-lane turn with a response that includes bold, inline code, a link, and citations. Watch the bubble mid-stream — no stray asterisks/backticks, no broken-link text, no `[src:` flashing. After `response_done`, the content matches what you'd see today.

## Commit message

```
feat(streaming-inline): markdown stabilizer for partial deltas

Pure render-only transform that virtually closes unclosed **, *, inline
backticks, and fenced code blocks, and elides trailing incomplete
citations and links from the rendered string. Envelope content stays
authoritative — stabilizer runs only when status=streaming and the
summary block is not yet ready. Eliminates mid-stream asterisk/backtick
flashes, broken-link previews, and raw [src: text. Snapshot convergence
and history replay are untouched.

Refs docs/streaming-inline/PLAN.md chunk 7.
```

## Deferrals

(append-only)
