// Custom alarm/timer tone generation — reuses the offline music engine (the same
// one behind the podcast stingers and the Music app). We render short loopable
// clips so a user can pick a generated melody as their ringtone. The chosen clip
// is persisted via the Music app's track storage (kind 'loop') and referenced from
// an alarm/timer as "track:<id>".

import {
  MUSIC_STYLES, resolveStyle, arrange, renderMidiToWav, wavDurationSec, hashStr,
  type LayerToggles,
} from '@/lib/music/engine'
import { saveTrack } from '@/lib/music/api'

// Bright, attention-getting instrument mixes — a ringtone wants melody up front.
const TONE_COMBOS: LayerToggles[] = [
  { drums: true, bass: true, pad: false, lead: true, keys: true },
  { drums: false, bass: false, pad: true, lead: true, keys: true },
  { drums: true, bass: true, pad: true, lead: true, keys: false },
  { drums: false, bass: true, pad: false, lead: true, keys: true },
]

export interface ToneVariant {
  key: number
  styleId: string
  label: string
  bpm: number
  blob: Blob
  previewUrl: string
}

/** Render six loopable tone previews. `offset` slides the style window + reseeds so
 *  "Regenerate" surfaces fresh takes. */
export async function generateToneVariants(offset = 0): Promise<ToneVariant[]> {
  const out: ToneVariant[] = []
  for (let i = 0; i < 6; i++) {
    const style = MUSIC_STYLES[(offset + i) % MUSIC_STYLES.length]!
    const seed = (hashStr(style.id) ^ Math.imul(offset + 1 + i, 2654435761)) >>> 0
    const combo = TONE_COMBOS[(seed + i) % TONE_COMBOS.length]!
    const resolved = { ...resolveStyle(style, seed), useLead: true }
    // 'loop' renders a tight, seamless 4-bar phrase — ideal for a repeating ringtone.
    const blob = await renderMidiToWav(arrange(resolved, { structure: 'loop', layers: combo }), 0.08)
    out.push({
      key: offset * 100 + i,
      styleId: style.id,
      label: style.label,
      bpm: resolved.bpm,
      blob,
      previewUrl: URL.createObjectURL(blob),
    })
  }
  return out
}

/** Persist a generated tone as a music track and return its "track:<id>" reference. */
export async function saveToneVariant(v: ToneVariant, title: string): Promise<string> {
  const id = await saveTrack(v.blob, {
    title,
    kind: 'loop',
    engine: 'midi-offline',
    styleId: v.styleId,
    bpm: v.bpm,
    durationSec: wavDurationSec(v.blob),
  })
  return `track:${id}`
}
