// Typed event bus for wake-word detection + activation provenance.
//
// PROVENANCE (design P0.0): every time the assistant starts listening/responding it
// has an ORIGIN. Historically these were indistinguishable to the user ("it just
// starts listening"), so a follow-up-VAD continuation or a barge-in read as a wake
// false-fire and was impossible to attribute. We tag each activation with its origin
// and keep a small ring buffer (plus a console line) so field reports and eval runs
// can tell a classifier fire from a follow-up from a barge-in.

export type ActivationOrigin =
  | 'onnx-wake'      // trained ONNX detector fired
  | 'whisper-wake'   // Whisper transcript + phrase match fired
  | 'barge-in'       // user talked over the companion's TTS
  | 'follow-up-vad'  // wake-word-free continuation window; VAD onset (no wake said)
  | 'manual'         // push-to-talk / explicit tap

export interface WakeDetectedEvent {
  modelId: string
  score: number
  threshold: number
  frameIndex: number
  timestamp: number
  /** Which detector fired. Defaults to 'onnx-wake' for back-compat with old emitters. */
  origin?: Extract<ActivationOrigin, 'onnx-wake' | 'whisper-wake'>
}

export interface ActivationRecord {
  origin: ActivationOrigin
  timestamp: number
  detail?: string
}

type Listener = (event: WakeDetectedEvent) => void

const listeners: Set<Listener> = new Set()

export function onWakeDetected(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitWakeDetected(event: WakeDetectedEvent): void {
  logActivation(event.origin ?? 'onnx-wake', `${event.modelId} score ${event.score.toFixed(2)} ≥ ${event.threshold.toFixed(2)}`)
  for (const l of listeners) l(event)
}

// ── Activation provenance ring buffer ────────────────────────────────────────

const ACTIVATION_LOG_MAX = 50
const activationLog: ActivationRecord[] = []

/** Record an activation with its origin. Called at every point the assistant starts
 *  listening/responding (wake fire, barge-in, follow-up VAD, manual). Cheap: pushes
 *  to a capped ring buffer and emits one console line. */
export function logActivation(origin: ActivationOrigin, detail?: string): void {
  const rec: ActivationRecord = { origin, timestamp: Date.now(), detail }
  activationLog.push(rec)
  if (activationLog.length > ACTIVATION_LOG_MAX) activationLog.shift()
  console.info(`[activation] origin=${origin}${detail ? `: ${detail}` : ''}`)
}

/** Recent activations, newest last. For diagnostics/eval; safe to call anytime. */
export function getRecentActivations(): readonly ActivationRecord[] {
  return activationLog
}
