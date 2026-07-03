import { useEffect, useRef } from 'react'
import { enqueueSpeech, stopSpeech } from '@/lib/voice/voicePlaybackStore'
import { stripEmotes } from '@/lib/emoteParser'
import { prosodyForChunk } from '@/lib/voice/prosody'

// Feeds the streaming assistant reply to TTS as it arrives (the backend further
// segments + streams PCM, the scheduler plays each chunk as it lands) so audio
// starts as soon as the first phrase exists — not after the whole reply.
//
// First chunk: flush on the FIRST sentence terminator (any length) OR the first
// clause boundary once it's long enough — whichever comes first — to minimize
// time-to-first-audio. Later chunks use full sentences for natural prosody.

// Chunk ONLY on real sentence terminators (.!?) and paragraph breaks (\n{2,}).
// A single newline is a soft wrap, not a boundary. We deliberately do NOT split at
// clause boundaries (commas) anymore: the old first-chunk clause-split shaved a
// little time-to-first-audio but chopped sentences mid-phrase ("Oh no," / "that's
// concerning!"), which is far more jarring than waiting for the first full sentence.
// Uppercase/digit lookahead keeps abbreviations (e.g., Dr.) from false-firing.
const SENTENCE_BOUNDARY = /[.!?]+(?=\s+[A-Z0-9]|\s*$)|\n{2,}/g
// Clause boundaries (comma/semicolon/colon/dash followed by space) — used ONLY to
// flush a long run-on sentence so audio starts without waiting for the whole thing.
const CLAUSE_BOUNDARY = /[,;:](?=\s)|\s[—–-](?=\s)/g
const WHOLE_SENTENCE_MAX = 130 // sentences up to this length play whole (no splitting)
const CLAUSE_FLUSH_MIN = 50    // never flush a clause shorter than this

// Fenced code blocks (```…```) must never be read aloud. The backend TTS strip only
// drops COMPLETE fences, but we chunk the reply into sentences as it streams — so a code
// block's interior lines arrive (and would be spoken) before its closing ``` exists.
// `dropFencedCode` removes anything inside a fence given whether the chunk starts inside
// one, returning the speakable text plus the updated fence state. Fence state at any
// point is derived from the already-consumed prefix (`text.slice(0, consumed)`) so it
// stays correct across cursor resets when a reply is replaced. Inline `code` is left
// alone (handled by the backend's stripForSpeech, which keeps its inner text).
function fenceOpenAt(prefix: string): boolean {
  return ((prefix.match(/```/g)?.length ?? 0) % 2) === 1
}
function dropFencedCode(chunk: string, inFence: boolean): { text: string; inFence: boolean } {
  let out = ''
  let i = 0
  for (;;) {
    const idx = chunk.indexOf('```', i)
    if (idx === -1) { if (!inFence) out += chunk.slice(i); break }
    if (!inFence) out += chunk.slice(i, idx)
    inFence = !inFence
    i = idx + 3
  }
  return { text: out, inFence }
}

// End offset of the next chunk in `sub`, or -1 if none yet. Prefer a real sentence
// end; but if a sentence is running long with no terminator in sight, flush at the
// last clause boundary so a 200-char run-on doesn't block the first audio. Short
// sentences are never clause-split (avoids "Oh no," / "that's" fragments).
function nextBoundary(sub: string): number {
  SENTENCE_BOUNDARY.lastIndex = 0
  const term = SENTENCE_BOUNDARY.exec(sub)
  const termEnd = term ? term.index + term[0].length : -1
  if (termEnd >= 0 && termEnd <= WHOLE_SENTENCE_MAX) return termEnd // whole sentence wins
  if (sub.length >= WHOLE_SENTENCE_MAX - 20) {
    CLAUSE_BOUNDARY.lastIndex = 0
    let clauseEnd = -1
    let m: RegExpExecArray | null
    while ((m = CLAUSE_BOUNDARY.exec(sub)) !== null) {
      const e = m.index + m[0].length
      if (e >= CLAUSE_FLUSH_MIN && e <= WHOLE_SENTENCE_MAX) clauseEnd = e // last in range
    }
    if (clauseEnd > 0) return clauseEnd
  }
  return termEnd
}

export function useCompanionVoice(opts: {
  text: string
  streaming: boolean
  characterId: string | null | undefined
  voiceOn: boolean
  /** Character's 0–1 prosody swing (DB `expressiveness`); null/undefined = default. */
  expressiveness?: number | null
}) {
  const { text, streaming, characterId, voiceOn, expressiveness } = opts
  const consumed = useRef(0)
  const prevText = useRef('')
  const prevStreaming = useRef(false)
  // Did we witness THIS reply stream in (go from idle → generating) on this mounted
  // instance? Off-chat, `companion.response` persists after it finishes, so without
  // this guard a remount or a voice/owner/character toggle would re-speak the whole
  // finished reply from scratch — the "greeting repeats every time I open Maps" bug.
  // Mirrors the chat path's `sawLiveGen` guard in CompanionEngineContext.
  const sawStreaming = useRef(false)
  // The tone (rate/gain) established by the first sentiment-bearing sentence of a reply,
  // carried across its later neutral sentences so the WHOLE reply is shaded.
  const replyTone = useRef<{ rateScale: number; gain: number } | null>(null)

  // Stop any in-flight TTS/audio when the component unmounts so the singleton
  // playback doesn't keep streaming and playing mid-utterance after teardown.
  useEffect(() => () => { stopSpeech() }, [])

  // A new generation started: cut any audio still playing from the previous reply.
  // (The cursor reset is driven by text identity below, NOT this edge — resetting
  // `consumed` here while `text` still holds the old reply would re-speak it.)
  useEffect(() => {
    if (streaming && !prevStreaming.current) {
      sawStreaming.current = true        // witnessing this reply generate live
      if (voiceOn) stopSpeech()          // cut audio still playing from the previous reply
    }
    prevStreaming.current = streaming
  }, [streaming, voiceOn])

  // Enqueue newly-completed chunks as the reply grows.
  useEffect(() => {
    // Muted (or no character): keep the cursor pinned to the end so flipping voice on
    // later starts from NEW text only — it never retroactively replays what played
    // (or would have played) while muted.
    if (!voiceOn || !characterId) { prevText.current = text; consumed.current = text.length; return }
    // Text is present but we never saw it stream in on this instance — e.g. the overlay
    // remounted onto a finished reply, or voice turned on after it completed. Adopt it
    // as already-spoken instead of replaying the whole thing aloud.
    if (!sawStreaming.current) { prevText.current = text; consumed.current = text.length; return }
    // A replaced reply (current text is NOT a continuation of what we've been
    // reading) resets the cursor — otherwise a stale `consumed` slices into the
    // middle of the new reply and speaks a stray fragment ("e what").
    if (!text.startsWith(prevText.current) || consumed.current > text.length) {
      consumed.current = 0
      replyTone.current = null
    }
    prevText.current = text
    const pending = text.slice(consumed.current)
    let localConsumed = 0
    let inFence = fenceOpenAt(text.slice(0, consumed.current))
    for (;;) {
      const sub = pending.slice(localConsumed)
      const end = nextBoundary(sub)
      if (end < 0) break
      const raw = sub.slice(0, end)
      const despoked = dropFencedCode(raw, inFence)
      inFence = despoked.inFence
      const chunk = stripEmotes(despoked.text)
      if (chunk) {
        // Derive prosody from the RAW chunk (emotes intact) before they're stripped.
        const p = prosodyForChunk(raw, expressiveness)
        if (p.rateScale !== 1 || p.gain !== 1) replyTone.current = p
        const tone = (p.rateScale !== 1 || p.gain !== 1) ? p : (replyTone.current ?? p)
        if (import.meta.env.DEV) console.log(`[PROSODY] rate=${tone.rateScale.toFixed(2)} gain=${tone.gain.toFixed(2)} «${chunk.slice(0, 45)}»`)
        void enqueueSpeech({ text: chunk, characterId, rateScale: tone.rateScale, gain: tone.gain })
      }
      localConsumed += end
    }
    consumed.current += localConsumed
  }, [text, voiceOn, characterId, expressiveness])

  // Flush the trailing fragment (no terminator) when generation ends.
  useEffect(() => {
    if (streaming || !voiceOn || !characterId) return
    if (!sawStreaming.current) return // never witnessed this reply generate — don't speak it
    const rawRest = text.slice(consumed.current)
    // Drop any trailing code — including an UNTERMINATED fence if the reply ended inside one.
    const rawSpeakable = dropFencedCode(rawRest, fenceOpenAt(text.slice(0, consumed.current))).text
    const rest = stripEmotes(rawSpeakable)
    if (rest) {
      const p = prosodyForChunk(rawRest, expressiveness)
      if (p.rateScale !== 1 || p.gain !== 1) replyTone.current = p
      const tone = (p.rateScale !== 1 || p.gain !== 1) ? p : (replyTone.current ?? p)
      if (import.meta.env.DEV) console.log(`[PROSODY] rate=${tone.rateScale.toFixed(2)} gain=${tone.gain.toFixed(2)} «${rest.slice(0, 45)}»`)
      void enqueueSpeech({ text: rest, characterId, rateScale: tone.rateScale, gain: tone.gain })
      consumed.current = text.length
    }
  }, [streaming, text, voiceOn, characterId, expressiveness])
}
