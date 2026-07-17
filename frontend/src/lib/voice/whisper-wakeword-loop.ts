// Training-free wakeword detection via Whisper STT.
//
// Instead of an ONNX phrase-detector that must be trained per word, this class
// opens a rolling series of STT WebSocket sessions, transcribes each utterance,
// and checks whether the result contains the configured phrase. Any text can be
// a wakeword — "hey loki", "computer", "yo", etc. — with no setup required.
//
// CRUCIAL for low latency + run-on commands ("hey loki what's today's date"):
// the SAME transcription that detects the phrase usually already contains the
// command. So on the final transcript we emit the wake event AND deliver the
// text after the phrase as the command (`onCommand`) — no separate capture
// session, no handoff gap that drops the start of the command. The hands-free
// hook keeps this loop running through `wake-detected`/`capturing` (it doesn't
// open its own command socket for phrase wake), so the one session captures the
// whole utterance.
//
// Matches the WakeWordLoop API (setEnabled / pushFrame) so the hands-free hook
// can swap implementations transparently.

import { emitWakeDetected } from './wake-word-events'
import { SttCapture } from './stt-capture'

const POST_WAKE_SUPPRESS_MS = 1500
const RESTART_BACKOFF_MS = 500
// Short silence endpoint so the command finalizes ~0.8s after the user stops,
// not the old 1.5s (which felt like "slow processing").
const SILENCE_TIMEOUT_S = 0.8

export class WhisperWakewordLoop {
  private enabled = false
  private phrase: string
  private normalizedPhrase: string
  private capture: SttCapture | null = null
  private lastFireAt: number | null = null
  // True after a bare "<phrase>" with no trailing command — the NEXT utterance
  // is then taken as the command (supports both "hey loki <cmd>" in one breath
  // and "hey loki" … pause … "<cmd>").
  private awaitingCommand = false
  /** Delivers the command spoken in the same breath as the wake phrase
   *  ("hey loki <command>") — the text after the phrase in the final transcript. */
  onCommand: ((text: string) => void) | null = null
  /** Live partial of the command portion as the user is still speaking, so the
   *  UI can echo "what you heard" during capture instead of staying blank until
   *  the final transcript arrives. */
  onPartial: ((text: string) => void) | null = null

  constructor(phrase: string) {
    this.phrase = phrase
    this.normalizedPhrase = normalizePhrase(phrase)
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (enabled) {
      this.startSession()
    } else {
      this.awaitingCommand = false
      this.stopSession()
    }
  }

  /** Forget a pending "<phrase> then command" — e.g. the capture window elapsed. */
  reset(): void {
    this.awaitingCommand = false
  }

  setPhrase(phrase: string): void {
    this.phrase = phrase
    this.normalizedPhrase = normalizePhrase(phrase)
  }

  pushFrame(samples: Float32Array): void {
    if (!this.enabled || !this.capture?.isOpen) return
    this.capture.sendFrame(samples)
  }

  private startSession(): void {
    if (!this.enabled) return
    const stt = new SttCapture()
    this.capture = stt

    stt.open(
      {
        onPartial: (text) => {
          // Do NOT fire the wake on a partial: partials are unstable hypotheses and
          // firing on them is a false-trigger source. Wake fires only on the FINAL
          // transcript (handleFinal). We still echo the command-so-far once the
          // phrase has matched, so the overlay shows "what you heard" during capture.
          const cmd = this.commandPortion(text)
          if (cmd) this.onPartial?.(cmd)
        },
        onFinal: (text) => {
          if (this.capture === stt) this.capture = null
          // Close the finished session before opening the next one so STT
          // sockets don't accumulate across utterances.
          stt.close()
          this.handleFinal(text)
          if (this.enabled) this.startSession()
        },
        onNoSpeech: () => {
          if (this.capture === stt) this.capture = null
          if (this.enabled) this.startSession()
        },
        onError: () => {
          if (this.capture === stt) this.capture = null
          if (this.enabled) setTimeout(() => { if (this.enabled) this.startSession() }, RESTART_BACKOFF_MS)
        },
        onClose: () => {
          if (this.capture === stt) this.capture = null
        },
      },
      { silenceTimeoutS: SILENCE_TIMEOUT_S, partialIntervalS: 0.5 },
    )
  }

  private stopSession(): void {
    const stt = this.capture
    this.capture = null
    stt?.close()
  }

  /**
   * Locate the wake phrase at the START of normalized text. Returns the {start,end}
   * char span of the match (so the command can be sliced from `end`), or null.
   *
   * Two deliberate constraints, both to stop the false triggers this path caused
   * (measured: the old matcher fired "hey loki" on "hey look at this" and "that guy
   * loki from the movie", "hey sol" on "hey so what do you think"):
   *   1. START-ANCHORED. A wake phrase is spoken at the beginning of an utterance,
   *      before any command. Only the first (or, tolerating one filler word, second)
   *      word position is considered; the phrase appearing mid-sentence is NOT a wake.
   *   2. TIGHT edit distance, no phonetic-skeleton match. The vowel-free skeleton
   *      collapsed "loki"/"look" and "sol"/"so", firing on ordinary speech. A short
   *      phrase gets at most one edit (a single edit already reaches a different real
   *      word); longer phrases scale to ~0.2×length.
   */
  private match(normText: string): { start: number; end: number } | null {
    const p = this.normalizedPhrase
    if (!p) return null // empty phrase must never match
    const words = normText.split(' ').filter(Boolean)
    const n = p.split(' ').length
    if (words.length < n) return null
    const maxEdits = p.length <= 9 ? 1 : p.length <= 15 ? 2 : Math.round(p.length * 0.2)
    const maxStart = Math.min(1, words.length - n) // word 0, or 1 (one leading filler)
    for (let i = 0; i <= maxStart; i++) {
      const window = words.slice(i, i + n).join(' ')
      if (window === p || levenshtein(window, p) <= maxEdits) {
        const start = i === 0 ? 0 : words.slice(0, i).join(' ').length + 1
        return { start, end: start + window.length }
      }
    }
    return null
  }

  /** Emit the wake event (rate-limited) if the text contains the phrase. */
  private fireWakeIfMatch(text: string): void {
    if (!this.match(normalizePhrase(text))) return
    const now = Date.now()
    if (this.lastFireAt !== null && now - this.lastFireAt < POST_WAKE_SUPPRESS_MS) return
    this.lastFireAt = now
    console.info(`[wakeword/whisper] detected "${text}" contains phrase "${this.phrase}"`)
    emitWakeDetected({ modelId: `phrase:${this.phrase}`, score: 1, threshold: 1, frameIndex: 0, timestamp: now, origin: 'whisper-wake' })
  }

  /** The command portion of a transcript: the words after the wake phrase, or
   *  the whole utterance if we're awaiting the command from an earlier bare
   *  phrase. Empty when this utterance is neither. Shared by the live partial
   *  echo and the final command delivery so both agree on what counts. */
  private commandPortion(text: string): string {
    const norm = normalizePhrase(text)
    const m = this.match(norm)
    if (m) return norm.slice(m.end).trim()
    return this.awaitingCommand ? norm.trim() : ''
  }

  /** On a final transcript: fire the wake (if not already) and deliver the
   *  trailing words as the command, so "hey loki <command>" works in one breath. */
  private handleFinal(text: string): void {
    const norm = normalizePhrase(text)
    const m = this.match(norm)
    // Log EVERY final transcript + whether it matched, so a "didn't register" wake is
    // visible: we see exactly what Whisper heard vs the phrase it's matching against.
    console.info(`[wakeword/whisper] heard "${text}" → norm="${norm}" wants="${this.normalizedPhrase}" match=${!!m}`)
    if (m) {
      this.fireWakeIfMatch(text) // no-op if the partial already fired it (suppressed)
      const command = norm.slice(m.end).trim()
      if (command) {
        this.awaitingCommand = false
        this.onCommand?.(command)
      } else {
        this.awaitingCommand = true // bare phrase — next utterance is the command
      }
      return
    }
    // No phrase this utterance — if we just heard a bare phrase, this is the command.
    if (this.awaitingCommand) {
      this.awaitingCommand = false
      const command = norm.trim()
      if (command) this.onCommand?.(command)
    }
  }
}

function normalizePhrase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
}

/** Classic edit distance (insert/delete/substitute), for fuzzy wake-phrase matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}
