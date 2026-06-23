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

// End offset of the next complete sentence in `sub`, or -1 if none yet.
function nextBoundary(sub: string): number {
  SENTENCE_BOUNDARY.lastIndex = 0
  const term = SENTENCE_BOUNDARY.exec(sub)
  return term ? term.index + term[0].length : -1
}

export function useCompanionVoice(opts: {
  text: string
  streaming: boolean
  characterId: string | null | undefined
  voiceOn: boolean
}) {
  const { text, streaming, characterId, voiceOn } = opts
  const consumed = useRef(0)
  const prevStreaming = useRef(false)

  // Stop any in-flight TTS/audio when the component unmounts so the singleton
  // playback doesn't keep streaming and playing mid-utterance after teardown.
  useEffect(() => () => { stopSpeech() }, [])

  // A new generation started: reset cursors and stop any prior audio.
  useEffect(() => {
    if (streaming && !prevStreaming.current) {
      consumed.current = 0
      if (voiceOn) stopSpeech()
    }
    prevStreaming.current = streaming
  }, [streaming, voiceOn])

  // Enqueue newly-completed chunks as the reply grows.
  useEffect(() => {
    if (!voiceOn || !characterId) return
    const pending = text.slice(consumed.current)
    let localConsumed = 0
    for (;;) {
      const sub = pending.slice(localConsumed)
      const end = nextBoundary(sub)
      if (end < 0) break
      const raw = sub.slice(0, end)
      const chunk = stripEmotes(raw)
      if (chunk) {
        // Derive prosody from the RAW chunk (emotes intact) before they're stripped.
        const { rateScale, gain } = prosodyForChunk(raw)
        if (import.meta.env.DEV) console.debug('[VOICE] chunk:', JSON.stringify(chunk))
        void enqueueSpeech({ text: chunk, characterId, rateScale, gain })
      }
      localConsumed += end
    }
    consumed.current += localConsumed
  }, [text, voiceOn, characterId])

  // Flush the trailing fragment (no terminator) when generation ends.
  useEffect(() => {
    if (streaming || !voiceOn || !characterId) return
    const rawRest = text.slice(consumed.current)
    const rest = stripEmotes(rawRest)
    if (rest) {
      const { rateScale, gain } = prosodyForChunk(rawRest)
      void enqueueSpeech({ text: rest, characterId, rateScale, gain })
      consumed.current = text.length
    }
  }, [streaming, text, voiceOn, characterId])
}
