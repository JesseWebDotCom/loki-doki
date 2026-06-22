// Offline stinger (intro/outro music) generator for the podcast Show Editor.
//
// The composition + rendering engine now lives in @/lib/music/engine (shared with
// the Music app). This module is a thin podcast-facing wrapper: it renders 2-bar
// intro previews for 6 styles and the matching 1-bar outro, exactly as before.

import {
  MUSIC_SAMPLE_RATE, MUSIC_STYLES, resolveStyle, arrange, renderMidiToWav, fileToWav, hashStr,
  type ResolvedArrangement, type LayerToggles,
} from '@/lib/music/engine'

// Instrumentation combos so each take has a different texture instead of always the full
// mix — full band, just drums+bass, drums+melody, a drumless mellow bed, etc. One is picked
// per take (seeded) and reused for that take's outro so the two ends match.
const LAYER_COMBOS: LayerToggles[] = [
  { drums: true,  bass: true,  pad: true,  lead: true,  keys: true  }, // full band
  { drums: true,  bass: true,  pad: false, lead: true,  keys: false }, // drums + bass + melody
  { drums: true,  bass: true,  pad: false, lead: false, keys: false }, // just drums + bass
  { drums: true,  bass: false, pad: false, lead: true,  keys: false }, // just drums + melody
  { drums: true,  bass: false, pad: true,  lead: true,  keys: false }, // drums + chords + melody
  { drums: true,  bass: true,  pad: true,  lead: false, keys: false }, // drums + bass + chords (groove bed)
  { drums: false, bass: true,  pad: true,  lead: true,  keys: true  }, // mellow, no drums
]

/** Deterministically pick a combo for take `i` of a regeneration; `i` spreads the 6
 *  visible takes across combos so a single batch shows real variety. */
function pickCombo(seed: number, i: number): LayerToggles {
  return LAYER_COMBOS[(((Math.imul(seed, 2246822519) >>> 0) >>> 0) + i) % LAYER_COMBOS.length]!
}

export const STINGER_SAMPLE_RATE = MUSIC_SAMPLE_RATE
/** @deprecated use ResolvedArrangement from @/lib/music/engine */
export type ResolvedStinger = ResolvedArrangement

export interface StingerVariant {
  key: number
  styleId: string
  label: string
  /** The exact arrangement behind this take — reused so the outro matches the intro. */
  resolved: ResolvedArrangement
  /** Which instrument layers this take uses — reused for the outro so both ends match. */
  layers: LayerToggles
  introBlob: Blob
  previewUrl: string
}

export interface StingerSelection {
  introBlob: Blob
  outroBlob: Blob
  previewUrl: string
}

/** One take: the engine resolves a fresh arrangement (now with procedurally-generated
 *  drums/bass/melody + a wider progression pool) and a layer combo for instrumentation
 *  texture, so every take genuinely differs. */
async function proceduralVariant(keyIndex: number, offset: number, i: number): Promise<StingerVariant> {
  const style = MUSIC_STYLES[(offset + i) % MUSIC_STYLES.length]!
  const seed = (hashStr(style.id) ^ Math.imul(offset + 1 + i, 2654435761)) >>> 0
  const layers = pickCombo(seed, i)
  // Force the lead on when the combo features melody (some styles default it off).
  const resolved = layers.lead ? { ...resolveStyle(style, seed), useLead: true } : resolveStyle(style, seed)
  const introBlob = await renderMidiToWav(arrange(resolved, { structure: 'intro', layers }), 0.5)
  return { key: offset * 100 + keyIndex, styleId: style.id, label: style.label, resolved, layers, introBlob, previewUrl: URL.createObjectURL(introBlob) }
}

/** Render six intro previews. `offset` slides the style window AND reseeds, so each
 *  "Regenerate" surfaces new styles and fresh takes. */
export async function generateStingerVariants(offset = 0): Promise<StingerVariant[]> {
  const out: StingerVariant[] = []
  for (let i = 0; i < 6; i++) out.push(await proceduralVariant(i, offset, i))
  return out
}

/** Render the matching outro for a chosen take (uses the take's exact arrangement). */
export async function renderStingerOutro(v: StingerVariant): Promise<Blob> {
  return renderMidiToWav(arrange(v.resolved, { structure: 'outro', layers: v.layers }), 0.6)
}

/** Transcode an uploaded audio file to a ≤6 s, 24 kHz mono WAV (used for both ends). */
export async function fileToStingerWav(file: File): Promise<Blob> {
  return fileToWav(file, 6)
}
