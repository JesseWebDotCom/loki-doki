// Typed event bus for wake-word detection. Ported verbatim from v2.

export interface WakeDetectedEvent {
  modelId: string
  score: number
  threshold: number
  frameIndex: number
  timestamp: number
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
  for (const l of listeners) l(event)
}
