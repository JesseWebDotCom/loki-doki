# LokiDoki TODO

## 1. Fix existing mac install issues
When setting up parent/child nodes, create/use a system like lmlink where the LLM procesing is happenign remotely over tailscale

## 2. Streaming voice — speak along with typing
Today TTS fires once at turn completion with the final `spoken_text` (see
[`ChatPage.tsx:799-803`](frontend/src/pages/ChatPage.tsx#L799-L803) — a single
`tts.speak()` call after the envelope is ready). Goal: audio tracks the
on-screen typing so the user hears the response as it's being written, not
after it's done.

**Scope (needs its own chunked plan under `docs/voice-streaming/`):**
- Streaming TTS backend — Piper supports incremental synthesis; expose a
  chunked interface that accepts sentence/clause fragments and emits audio
  frames as they're synthesized.
- Text chunker — split the streaming summary block on sentence/clause
  boundaries as `block_patch` deltas arrive; hand each chunk to TTS as
  soon as it closes.
- Pacing — the audio cannot race ahead of the typed text or lag far
  behind. Likely: buffer one sentence ahead, gate playback on the visual
  typewriter.
- Barge-in — user mic activity must cut the stream cleanly (chunk 16
  wired this for full-text play; needs to extend to mid-stream).
- Kiosk / status-phrase interaction — the existing "Warming Up / Checking
  Sources" status audio must not collide with streamed response audio.

**Do NOT start before designing:** this changes the whole TTS pipeline
shape, not just a frontend tweak.

## 3. Stream response directly into the final message bubble (no swap)
Today a `ThinkingIndicator` renders the streaming tokens with dim / smaller
typography (`text-sm text-muted-foreground animate-pulse` in
[`ThinkingIndicator.tsx`](frontend/src/components/chat/ThinkingIndicator.tsx))
while the turn is in flight. When the turn completes, the indicator
disappears and a freshly-built `MessageItem` bubble appears with full-size
markdown typography. The swap is visible and jarring — the user sees
"typing in dim / small" followed by "complete show of that text all at once".

Goal: the streaming tokens land inside the final `MessageItem` bubble
from the first delta, so the user sees the typing happen *in place* with
the final styling. No two components rendering the same content.

**Sketch (needs its own chunk under `docs/streaming-inline/`):**
- Push an in-progress assistant message onto `messages` as soon as
  `response_init` fires, with its `envelope` bound to the live
  `envelopeRef`.
- Mirror the envelope into React state (not just the ref) so
  `MessageItem` re-renders on every `block_patch`.
- `ThinkingIndicator` keeps the phase chrome (Warming Up / Planning /
  Checking Sources / Wrapping Up) but drops `interimText` — the text is
  already rendering in the bubble.
- On turn completion, flip `envelope.status` from `streaming` → `complete`
  in place; don't replace the message object.
- History replay path stays unchanged (messages load with a complete
  envelope, same as today).

**Interactions:**
- Related to TODO item 2 (streaming voice) — both want tokens to flow
  into a live surface. Doing this first de-risks voice.
- Must not regress the snapshot-merge fix — the final `response_snapshot`
  should still converge on the backend-authoritative block content (e.g.
  `<spoken_text>` stripped, citations sanitized).

## 4. Offline structured stub — parse ZIM H2 sections into markdown
When the fast-path fires (good ZIM hit, Auto mode, non-rich routing) we
dump the Wikipedia lead paragraph verbatim with no structure. We could
do a LOT better without engaging the LLM: Wikipedia ZIM articles have
`<h2>` section headers (Early life, Career, Awards, …) that the
existing `_LeadExtractor` already captures into `parser.sections`. A
deterministic "structured stub" could:

- Extract the lead paragraph as a short overview.
- Extract the first 2–3 `<h2>` sections and their opening paragraph each.
- Emit the whole thing as markdown (`## Section\n\n<paragraph>\n\n...`).
- Zero LLM, still offline, still fast — but structured.

That way the Auto-mode "who is X" path stays snappy AND looks like the
Rich/Deep path. Rich/Deep still use full LLM synthesis for the
conversational framing. Scope note: this is a nice win on a Pi where
LLM synthesis is 10–30 s but the user asked for a quick lookup.

## 5. Multi-user presence & cross-session interaction
Allow users to see other members' characters, whether they are active, and interact with them.

**Example:** You see Daisy's character is awake (she's using LokiDoki). You can either:
- Direct message her — your character appears on her screen, or
- Instruct her character to speak something without her prompting it.

**Privacy rules (required before build):**
- Per-user policy for inbound interactions:
  - *Open*: anyone approved can "hop in" without prompt (e.g., Daisy → open to close contacts).
  - *Approval required*: each inbound interaction prompts the recipient, similar to screen-control approval.
- Presence visibility is itself opt-in (awake/asleep/invisible).
- Audit log of who spoke through whose character and when.
- Scope decisions: does this live in core, a plugin, or a new shared-presence service? (TBD — likely plugin + core presence hooks.)
