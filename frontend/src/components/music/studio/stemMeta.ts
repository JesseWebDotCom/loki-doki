// Display metadata for stems + the separation-layout options (matches Moises' sheet).
import { Mic, Drum, Guitar, Piano, Music4, AudioLines, Music2, type LucideIcon } from 'lucide-react'
import type { StemModel } from '@/lib/music/studioApi'

// Per-stem colour (hex kept in this .ts file so it's exempt from the tsx hex/palette rules;
// applied via inline style, LANDR-style). One distinct hue per instrument.
export interface StemInfo { label: string; icon: LucideIcon; color: string }

const STEM_INFO: Record<string, StemInfo> = {
  vocals: { label: 'Vocals', icon: Mic, color: '#ec4899' },        // pink
  drums: { label: 'Drums', icon: Drum, color: '#f59e0b' },         // amber
  bass: { label: 'Bass', icon: AudioLines, color: '#3b82f6' },     // blue
  guitar: { label: 'Guitar', icon: Guitar, color: '#22c55e' },     // green
  piano: { label: 'Piano', icon: Piano, color: '#eab308' },        // yellow
  other: { label: 'Other', icon: Music4, color: '#14b8a6' },       // teal
  no_vocals: { label: 'Instrumental', icon: Music2, color: '#14b8a6' },
}

export function stemInfo(name: string): StemInfo {
  return STEM_INFO[name] ?? { label: name.charAt(0).toUpperCase() + name.slice(1), icon: Music4, color: '#8b8b8b' }
}

export interface ModelOption { model: StemModel; label: string; tracks: string; count: number }

export const MODEL_OPTIONS: ModelOption[] = [
  { model: '6-stem', label: 'Vocals, Drums, Bass, Guitar, Piano, Other', tracks: '6 tracks', count: 6 },
  { model: '4-stem', label: 'Vocals, Drums, Bass, Other', tracks: '4 tracks', count: 4 },
  { model: '2-stem', label: 'Vocals, Instrumental', tracks: '2 tracks', count: 2 },
]

// The instruments a Custom separation can isolate (what Demucs can reliably deliver).
export const CUSTOM_STEMS: { name: import('@/lib/music/studioApi').CustomStem; label: string }[] = [
  { name: 'vocals', label: 'Vocals' },
  { name: 'drums', label: 'Drums' },
  { name: 'bass', label: 'Bass' },
  { name: 'guitar', label: 'Guitar' },
  { name: 'piano', label: 'Piano' },
  { name: 'other', label: 'Other' },
]
