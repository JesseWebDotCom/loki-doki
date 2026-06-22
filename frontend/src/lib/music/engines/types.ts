// Music engine registry — the extensibility seam for the Music app.
//
// v1 ships exactly one engine, `midi-offline` (client-side, instant, free). The
// interface is deliberately engine-agnostic so a future neural engine (Suno-like,
// `location: 'server'`, with vocals/lyrics) registers here without the page,
// Library, or storage layer changing. This mirrors the voice-engine registry
// (Piper + F5). Stem separation is modeled separately as a track *processor*.

import type { Structure } from '@/lib/music/engine'

export type EngineLocation = 'client' | 'server'

export interface MusicEngineCapabilities {
  /** Generate from style/params (the Generate tab). */
  generate: boolean
  /** Restyle an imported MIDI/audio source (the Remix tab). */
  remix: boolean
  /** Free-text prompt → audio (neural engines). */
  prompt: boolean
}

/** Parameters for a single generated take. Fields beyond `styleId`/`structure`
 *  are optional so server engines (which take a `prompt` instead) fit the same call. */
export interface MusicGenParams {
  styleId: string
  structure: Structure
  bars?: number
  seed?: number
  bpm?: number
  keyName?: string
  /** Free-text description — ignored by midi-offline, used by neural engines. */
  prompt?: string
  /** Where this take came from (remix import filename, etc.) — stored as provenance. */
  sourceName?: string
}

export interface MusicGenResult {
  blob: Blob
  durationSec: number
  meta: {
    engine: string
    styleId?: string
    bpm?: number
    keyName?: string
    structure?: Structure
    seed?: number
    sourceName?: string
  }
}

export interface MusicEngine {
  id: string
  label: string
  location: EngineLocation
  capabilities: MusicEngineCapabilities
  /** Produce one take. Client engines render directly; a future server engine
   *  would resolve this once its job completes — the call shape is unchanged. */
  generate(params: MusicGenParams): Promise<MusicGenResult>
}

const registry = new Map<string, MusicEngine>()

export function registerEngine(engine: MusicEngine): void {
  registry.set(engine.id, engine)
}
export function getEngine(id: string): MusicEngine | undefined {
  return registry.get(id)
}
export function listEngines(): MusicEngine[] {
  return [...registry.values()]
}
