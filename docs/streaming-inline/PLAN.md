# Streaming Inline — Execution Plan

Goal: streaming tokens land inside the final [`MessageItem`](../../frontend/src/components/chat/MessageItem.tsx) bubble from the first `block_patch`, so the user sees the typing happen *in place* with the final typography. No more `ThinkingIndicator` → `MessageItem` swap. When every chunk below is `done`: one component renders the streamed prose; `ThinkingIndicator` keeps its phase chrome but drops `interimText`; `envelope.status` flips `streaming` → `complete` in place without replacing the message object; history replay and the fast-lane (no-envelope) path are unchanged.

Related: [TODO.md §3](../../TODO.md). De-risks [TODO.md §2 (voice streaming)](../voice-streaming/PLAN.md) — both want tokens flowing into a live surface.

---

## How to use this document (Claude Code operating contract)

You are a fresh Claude Code session. You have been pointed at this file and given no other instructions.

**Do exactly this:**

1. Read the **Status** table below. Pick the **first** chunk whose status is `pending` — call it Chunk N.
2. Open `chunk-N-*.md` and read it completely. **Do not open any other chunk doc.**
3. Execute every step in its `## Actions` section.
4. Run the command in its `## Verify` section. If it fails, do not proceed — diagnose or record the block and stop. Do not fake success.
5. If verify passes:
   - Stage only the files the chunk touched.
   - Commit using the template in the chunk's `## Commit message` section. Follow `memory/feedback_no_push_without_explicit_ask.md` — **commit only; do not push, open a PR, or merge.**
   - Edit this `PLAN.md`: flip the chunk's row from `pending` to `done` and paste the commit SHA in the `Commit` column.
   - If during execution you discovered work that had to be pushed to a later chunk, append a `## Deferred from Chunk N` bullet list to that later chunk's doc with the specifics.
6. **Stop.** Do not begin the next chunk in the same session. Each chunk gets its own fresh context to keep token use minimal.

**If blocked** (verify keeps failing, required file is missing, intent of the chunk is unclear): leave the chunk status as `pending`, write a `## Blocker` section at the bottom of that chunk's doc explaining what's wrong, and stop. Do not guess.

**Scope rule**: only touch files listed in the chunk doc's `## Files` section. If work sprawls beyond that list, stop and defer the sprawl to a later chunk rather than expanding this one.

---

## Status

| # | Chunk | Status | Commit |
|---|---|---|---|
| 1 | [Mirror envelope to React state](chunk-1-envelope-state.md) | done | 5cca324 |
| 2 | [Push in-progress assistant message on `response_init`](chunk-2-in-progress-message.md) | done | c5a35ca |
| 3 | [Block renderers handle `streaming` envelope / `partial` block state](chunk-3-block-render-streaming.md) | done | cc5f137 |
| 4 | [`ThinkingIndicator` loses `interimText`, keeps phase chrome](chunk-4-indicator-chrome-only.md) | done | 584844a |
| 5 | [Completion path — flip `status` in place, no append-on-done](chunk-5-completion-flip.md) | done | c1754ee |
| 6 | [Tests — progressive-in-place, history replay, fast-lane fallback](chunk-6-tests.md) | done | ad6ac41 |

---

## Global context (read once, applies to every chunk)

### Hard rules (from CLAUDE.md — non-negotiable)

- **Offline-first runtime.** No CDN, remote font, remote analytics at runtime.
- **Onyx Material + shadcn/ui only.** No raw HTML, no bespoke styling.
- **No browser dialogs.** Use `ConfirmDialog` or a `Dialog`-based component.
- **No regex/keyword classification of user intent.** Branch on decomposer fields.
- **Push rules.** Commit only. Do not push / open a PR / merge.

### Code landmarks (verified against current tree)

| Concern | Path | Key symbols / lines |
|---|---|---|
| Streaming handler | `frontend/src/pages/ChatPage.tsx` | `envelopeRef` (L304), `isResponseEvent` branch (L628–674), end-of-turn append (L808–859), `tts.speak` call (L850) |
| Response reducer | `frontend/src/utils/responseReducer.ts` (or equivalent) | `reduceResponse()` — produces immutable envelopes from `response_init` / `block_patch` / `response_snapshot` events |
| Thinking indicator | `frontend/src/components/chat/ThinkingIndicator.tsx` | `interimText` prop (L5–10), renders under phase chip (L32–34) |
| Message bubble | `frontend/src/components/chat/MessageItem.tsx` | `assistantBlocks` memo (L132–160), `envelope.status === 'streaming'` already gates `DeepWorkFrame` (L343) |
| Backend emitter | `lokidoki/orchestrator/core/pipeline_phases.py` | `_emit_envelope_events()` (L707–822), `response_init` (L726), per-block `block_patch` (L748–773), `response_snapshot` (L784) |
| Event phase constants | `lokidoki/orchestrator/response/events.py` | `RESPONSE_INIT`, `BLOCK_PATCH`, `RESPONSE_SNAPSHOT`, `RESPONSE_DONE`, `BLOCK_READY`, `BLOCK_FAILED` (L44–52) |

### Invariants to preserve

- **Fast-lane path** (no `response_init` emitted, `envelopeRef.current === undefined`) must still fall back to legacy block construction from `synthesis` payload ([`MessageItem.tsx` L137–159](../../frontend/src/components/chat/MessageItem.tsx#L137-L159)).
- **History replay** loads messages from the DB with a complete envelope; rendering path must remain byte-identical to today's snapshot render.
- **Session-bleed guard** (`inflightTurnSessionRef` vs `currentSessionIdRef`, [`ChatPage.tsx` L803–858](../../frontend/src/pages/ChatPage.tsx#L803-L858)) must still prevent mid-flight turns from polluting a session the user left.
- **Snapshot convergence** — on `response_snapshot`, the in-place envelope must adopt the backend-authoritative block content (e.g. `<spoken_text>` stripped, citations sanitized). Do not regress the snapshot-merge fix.
- **TTS call stays at completion.** Chunk 16 (`resolveSpokenText` + `tts.speak('msg-N', ...)`) fires once, idempotently, at turn completion. Streaming voice is TODO §2 / `docs/voice-streaming/` — not this plan.

---

## NOTE

Append-only. Record cross-chunk discoveries or deferrals that change the plan.
