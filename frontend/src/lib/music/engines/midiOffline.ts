// The `midi-offline` engine — the only engine in v1. Wraps the in-browser MIDI
// engine (tonal → @tonejs/midi → spessasynth soundfont synth). Instant, free, no
// network after the one-time soundfont fetch.

import {
  getStyle, resolveStyle, renderArrangement, wavDurationSec, hashStr, MUSIC_STYLES,
} from '@/lib/music/engine'
import { registerEngine, type MusicEngine, type MusicGenParams, type MusicGenResult } from './types'

async function generate(params: MusicGenParams): Promise<MusicGenResult> {
  const style = getStyle(params.styleId) ?? MUSIC_STYLES[0]!
  const seed = (params.seed ?? hashStr(`${style.id}:${Math.floor(performance.now())}`)) >>> 0
  const resolved = resolveStyle(style, seed, { bpm: params.bpm, keyName: params.keyName })
  const blob = await renderArrangement(resolved, { structure: params.structure, bars: params.bars })
  return {
    blob,
    durationSec: wavDurationSec(blob),
    meta: {
      engine: 'midi-offline',
      styleId: style.id,
      bpm: resolved.bpm,
      keyName: resolved.keyName,
      structure: params.structure,
      seed,
      sourceName: params.sourceName,
    },
  }
}

export const midiOfflineEngine: MusicEngine = {
  id: 'midi-offline',
  label: 'Offline (MIDI)',
  location: 'client',
  capabilities: { generate: true, remix: true, prompt: false },
  generate,
}

registerEngine(midiOfflineEngine)
