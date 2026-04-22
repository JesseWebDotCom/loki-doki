# Voice Streaming — Execution Plan

Goal: TTS audio tracks the on-screen typing so the user hears the response as it's being written, not after it's done. When every chunk below is `done`: Piper synthesizes sentence-at-a-time; the frontend chunks streaming summary text on sentence/clause boundaries and queues each fragment; playback pacing buffers one sentence ahead of the visual typewriter; barge-in cuts mid-stream cleanly; the "Warming Up / Checking Sources" status audio doesn't collide with streamed response audio.

Prerequisite: [`docs/streaming-inline/`](../streaming-inline/PLAN.md) complete — this plan depends on a stable in-place summary bubble that updates on every `block_patch`.

Related: [TODO.md §2](../../TODO.md). Must not regress chunk 16 voice-parity (single-call TTS at turn completion remains the fast-lane fallback).

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

**If blocked**: leave the chunk status as `pending`, write a `## Blocker` section at the bottom of that chunk's doc explaining what's wrong, and stop. Do not guess.

**Scope rule**: only touch files listed in the chunk doc's `## Files` section.

---

## Status

| # | Chunk | Status | Commit |
|---|---|---|---|
| 1 | [Design doc — architecture, contracts, invariants](chunk-1-design.md) | done | |
| 2 | [Piper incremental-synthesis backend endpoint](chunk-2-piper-streaming.md) | done | |
| 3 | [Frontend sentence/clause chunker on `block_patch`](chunk-3-sentence-chunker.md) | done | |
| 4 | [TTS queue + typewriter-paced playback gate](chunk-4-pacing-gate.md) | done | f0019c9 |
| 5 | [Mid-stream barge-in](chunk-5-barge-in.md) | pending | |
| 6 | [Kiosk status-phrase coexistence](chunk-6-kiosk-coexistence.md) | pending | |
| 7 | [Tests + regression suite](chunk-7-tests.md) | pending | |

---

## Global context (read once, applies to every chunk)

### Hard rules (from CLAUDE.md — non-negotiable)

- **Offline-first runtime.** TTS synthesis is local Piper on CPU, always. No remote speech services. Bootstrap is the only network boundary.
- **TTS never routes to Hailo.** CPU only, all profiles.
- **No out-of-band installs.** Python deps in `pyproject.toml`, pinned runtime binaries in `lokidoki/bootstrap/versions.py`.
- **No vendored third-party artifacts.** Voice models download via bootstrap.
- **Onyx Material + shadcn/ui only** for any UI added.
- **Push rules.** Commit only.

### Code landmarks (verified against current tree)

| Concern | Path | Key symbols / lines |
|---|---|---|
| Piper bootstrap | `lokidoki/bootstrap/preflight/piper_runtime.py` | voice download (`.onnx` + `.onnx.json`), `.lokidoki/piper/voices/` |
| TTS backend | `lokidoki/providers/tts/` (locate via `rg -n "piper" lokidoki/providers`) | Piper synth entry |
| TTS endpoint | `frontend/src/utils/VoiceStreamer.ts` | `stream(text, options)` (L62–123); hits `/api/v1/audio/tts/stream`; consumes ndjson PCM chunks with visemes |
| Frontend TTS controller | `frontend/src/utils/tts.ts` | `speak(messageKey, text)` (L247–251), `speakStatus(phaseKey, phrase)` (L231–239), `bargeIn()` (L205–208) |
| Barge-in wiring | `frontend/src/pages/ChatPage.tsx` | `block_failed` → `ttsController.bargeIn()` (L635–640); input focus/keypress (L1256–1267) |
| Status TTS | `frontend/src/pages/ChatPage.tsx` | `status` block_patch → `ttsController.speakStatus()` (L645–657) |
| Completion TTS | `frontend/src/pages/ChatPage.tsx` | `tts.speak(msg-N, spoken)` (L850) |
| Status strings | `lokidoki/orchestrator/response/status_strings.py` | phase phrases |

### Invariants to preserve

- **Chunk 16 one-call TTS is the fallback.** When streaming voice is disabled (user setting, fast-lane turn, or error), behavior reverts to single `tts.speak()` at `response_done`.
- **Idempotent per messageKey.** `tts.speak('msg-N', ...)` must still be safe to call at turn completion even if streaming already spoke parts of the message — completion call becomes a no-op or a finalization signal.
- **Piper CPU-only on all profiles.** No Hailo. No remote speech.
- **Kiosk status audio already throttled** (≥3s gate, ≤1 per phase). Streaming response audio cannot retrigger status phrases once it starts.
- **Barge-in is existing contract.** `bargeIn()` cancels current utterance within 50ms. Must extend to cancel in-flight sentence + drain queued backlog.

---

## NOTE

Append-only. Record cross-chunk discoveries or deferrals that change the plan.
