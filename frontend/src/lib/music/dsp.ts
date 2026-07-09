// DSP settings: persistence + presets for the Web-Audio chain in lib/mediaAudioGraph.
// Stored in localStorage (like music.djMode) - EQ is inherently PER-DEVICE (it compensates
// for the speakers/headphones attached to this machine), so device-local is the right
// scope, not a synced user preference. applyStoredDsp() runs the stored settings into the
// graph layer; call it once at engine start and after every settings change.

import { applyDsp, DEFAULT_DSP, FLAT_EQ, type DspSettings, type EqGains } from '@/lib/mediaAudioGraph'

export type { DspSettings, EqGains }
export { DEFAULT_DSP, FLAT_EQ }

const KEY = 'music.dsp'

export interface EqPreset { name: string; gains: EqGains }

// Ten bands: 31 62 125 250 500 1k 2k 4k 8k 16k
export const EQ_PRESETS: EqPreset[] = [
  { name: 'Flat', gains: [...FLAT_EQ] },
  { name: 'Bass Boost', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { name: 'Rock', gains: [4, 3, 1, -1, -2, -1, 1, 3, 4, 4] },
  { name: 'Pop', gains: [-1, 0, 2, 3, 3, 2, 0, -1, -1, -1] },
  { name: 'Jazz', gains: [3, 2, 0, 1, 2, 2, 0, 1, 2, 3] },
  { name: 'Vocal', gains: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  { name: 'Treble', gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { name: 'Loudness', gains: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5] },
]

const clampDb = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
  return Math.max(-12, Math.min(12, n))
}

export function loadDsp(): DspSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_DSP, eqGains: [...DEFAULT_DSP.eqGains] }
    const p = JSON.parse(raw) as Partial<DspSettings>
    const gains = Array.isArray(p.eqGains) ? FLAT_EQ.map((_, i) => clampDb(p.eqGains![i])) : [...FLAT_EQ]
    return {
      eqOn: p.eqOn === true,
      eqGains: gains,
      crossfeed: p.crossfeed === true,
      loudnessOn: p.loudnessOn !== false,   // default on
    }
  } catch {
    return { ...DEFAULT_DSP, eqGains: [...DEFAULT_DSP.eqGains] }
  }
}

export function saveDsp(s: DspSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* quota */ }
  applyDsp(s)
}

/** Run the stored settings into the live audio graphs (idempotent). */
export function applyStoredDsp(): void {
  applyDsp(loadDsp())
}
