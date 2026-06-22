import { useEffect, useRef } from 'react'
import { enqueueSpeech, stopSpeech } from '@/lib/voice/voicePlaybackStore'
import { stripEmotes } from '@/lib/emoteParser'

// Feeds the streaming assistant reply to TTS as it arrives (the backend further
// segments + streams PCM, the scheduler plays each chunk as it lands) so audio
// starts as soon as the first phrase exists — not after the whole reply.
//
// First chunk: flush on the FIRST sentence terminator (any length) OR the first
// clause boundary once it's long enough — whichever comes first — to minimize
// time-to-first-audio. Later chunks use full sentences for natural prosody.

// Require uppercase or digit after the space so abbreviations like e.g., i.e.,
// R.E.M., Dr. etc. don't false-fire as sentence ends.
const SENTENCE_BOUNDARY = /[.!?]+(?=\s+[A-Z0-9]|\s*$)|\n+/g
const CLAUSE_BOUNDARY = /[,;:]+(?=\s|$)|[—–]/g
const MIN_FIRST_CHUNK = 12

// End offset of the next chunk in `sub`, or -1 if none yet. For the first chunk
// we also allow a clause break (when the chunk is already substantial).
function nextBoundary(sub: string, allowClause: boolean): number {
  SENTENCE_BOUNDARY.lastIndex = 0
  const term = SENTENCE_BOUNDARY.exec(sub)
  const termEnd = term ? term.index + term[0].length : -1
  if (!allowClause) return termEnd

  CLAUSE_BOUNDARY.lastIndex = 0
  let clauseEnd = -1
  let m: RegExpExecArray | null
  while ((m = CLAUSE_BOUNDARY.exec(sub)) !== null) {
    const e = m.index + m[0].length
    if (sub.slice(0, e).trim().length >= MIN_FIRST_CHUNK) { clauseEnd = e; break }
  }
  if (termEnd < 0) return clauseEnd
  if (clauseEnd < 0) return termEnd
  return Math.min(termEnd, clauseEnd)
}

export function useCompanionVoice(opts: {
  text: string
  streaming: boolean
  characterId: string | null | undefined
  voiceOn: boolean
}) {
  const { text, streaming, characterId, voiceOn } = opts
  const consumed = useRef(0)
  const firstSent = useRef(false)
  const prevStreaming = useRef(false)

  // Stop any in-flight TTS/audio when the component unmounts so the singleton
  // playback doesn't keep streaming and playing mid-utterance after teardown.
  useEffect(() => () => { stopSpeech() }, [])

  // A new generation started: reset cursors and stop any prior audio.
  useEffect(() => {
    if (streaming && !prevStreaming.current) {
      consumed.current = 0
      firstSent.current = false
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
      const end = nextBoundary(sub, !firstSent.current)
      if (end < 0) break
      const chunk = stripEmotes(sub.slice(0, end))
      if (chunk) {
        void enqueueSpeech({ text: chunk, characterId })
        firstSent.current = true
      }
      localConsumed += end
    }
    consumed.current += localConsumed
  }, [text, voiceOn, characterId])

  // Flush the trailing fragment (no terminator) when generation ends.
  useEffect(() => {
    if (streaming || !voiceOn || !characterId) return
    const rest = stripEmotes(text.slice(consumed.current))
    if (rest) {
      void enqueueSpeech({ text: rest, characterId })
      consumed.current = text.length
    }
  }, [streaming, text, voiceOn, characterId])
}
