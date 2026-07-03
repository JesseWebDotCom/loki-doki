// Shared shapes for the multi-voice narration engine.

/** One speaker detected in a text, before it's assigned a voice or persisted. */
export interface RawTurn {
  speaker: string   // raw label as detected — '' / 'Narrator' for plain narration
  text: string
}

export type DetectionMethod = 'script-heuristic' | 'llm' | 'regex-fallback' | 'single-narrator'

export interface DetectionResult {
  turns: RawTurn[]
  method: DetectionMethod
}

/** A canonicalized speaker with its assigned voice, ready to persist. */
export interface SpeakerAssignment {
  normalizedKey: string
  label: string
  voiceId: string
  speechRate: number
  isNarrator: boolean
}

export interface NormalizedTurn {
  normalizedKey: string
  text: string
}
