// End-to-end voice-turn timing (Phase 0 of the voice-latency plan, see
// docs/internal/voice-latency.md). Before this, [TTS-TIMING] and [CHAT-TIMING]
// each measured only their own leg; nothing captured "user stopped talking →
// first spoken word", which is the number that actually decides whether the
// assistant feels like a human friend answering.
//
// All marks are on the SAME frontend clock (performance.now), so no server/client
// clock-sync is needed: the browser observes the VAD-offset message arriving, the
// first reply token, and the first real audio sample, and logs the breakdown when
// the loop closes. Server-side legs keep their own logs ([VOICE-STT], [TTS-TIMING]).
//
// A turn is only reported if it genuinely ran through speech capture (a `final`
// mark exists), so typed sends that reach first-audio never log a bogus timeline.

export type VoiceMark = 'speechEnd' | 'final' | 'firstToken' | 'firstAudio'

interface TurnMarks {
  speechEnd?: number
  final?: number
  firstToken?: number
  firstAudio?: number
}

let cur: TurnMarks = {}
// Only a turn that captured speech (reached `final`) is a real voice turn worth
// reporting. Guards against a typed send's first-audio logging a stale timeline.
let active = false

/** Record one stage of the current voice turn on the frontend clock. */
export function markVoice(name: VoiceMark): void {
  const t = performance.now()
  if (name === 'final') {
    // A new spoken turn is closing capture: anchor a fresh timeline. `speechEnd`
    // (if the VAD-offset was seen) is already in `cur` from this same turn.
    active = true
    cur.final = t
    return
  }
  if (name === 'firstAudio') {
    cur.firstAudio = t
    if (active) report()
    return
  }
  if (name === 'speechEnd') {
    // Starts (or restarts) a timeline; the matching `final` follows shortly.
    cur = { speechEnd: t }
    active = false
    return
  }
  // firstToken
  if (active) cur.firstToken = t
}

/** Abandon the in-flight timeline (turn cancelled, stop command, teardown). */
export function resetVoiceTiming(): void {
  cur = {}
  active = false
}

function report(): void {
  const { speechEnd, final, firstToken, firstAudio } = cur
  if (final == null || firstAudio == null) { resetVoiceTiming(); return }
  const parts: string[] = []
  if (speechEnd != null) parts.push(`endpoint→final=${(final - speechEnd).toFixed(0)}ms`)
  if (firstToken != null) {
    parts.push(`final→firstToken=${(firstToken - final).toFixed(0)}ms`)
    parts.push(`firstToken→audio=${(firstAudio - firstToken).toFixed(0)}ms`)
  } else {
    parts.push(`final→audio=${(firstAudio - final).toFixed(0)}ms`)
  }
  const total = speechEnd != null ? firstAudio - speechEnd : firstAudio - final
  const totalLabel = speechEnd != null ? 'endpoint→audio' : 'final→audio'
  console.info(`[VOICE-TIMING] ${totalLabel}(total)=${total.toFixed(0)}ms · ${parts.join(' · ')}`)
  resetVoiceTiming()
}
