// The Moosic-style codec pill under the seek bar: "ALAC · 44.1/16 · 807 kbps",
// "FLAC · 44.1/16" with a Lossless accent, or "MP3 · 192 kbps". Facts come from the
// track's own source index (local/plex) or the audio scan; hides entirely when unknown.

import { useEffect, useState } from 'react'
import { AudioLines } from 'lucide-react'
import { cn } from '@/lib/cn'
import { getAudioFacts, type TrackAudioFacts } from '@/lib/music/metaApi'

const LOSSLESS = /flac|alac|pcm|wav|aiff/i

function label(f: TrackAudioFacts): { codec: string; detail: string[]; lossless: boolean } {
  const raw = (f.codec ?? '').replace(/MPEG.*Layer 3/i, 'MP3').replace(/MPEG-4\s*/i, '').toUpperCase()
  const lossless = LOSSLESS.test(raw)
  const detail: string[] = []
  if (lossless && f.sampleRate) {
    const khz = (f.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')
    detail.push(f.bitDepth ? `${khz}/${f.bitDepth}` : `${khz} kHz`)
  }
  if (f.bitrateKbps) detail.push(`${f.bitrateKbps} kbps`)
  return { codec: raw.slice(0, 8), detail, lossless }
}

export function TrackTechBadge({ trackRef, className }: { trackRef: string; className?: string }) {
  const [facts, setFacts] = useState<TrackAudioFacts | null>(null)

  useEffect(() => {
    let alive = true
    setFacts(null)
    getAudioFacts(trackRef).then((f) => { if (alive) setFacts(f) })
    return () => { alive = false }
  }, [trackRef])

  if (!facts?.codec) return null
  const { codec, detail, lossless } = label(facts)
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium tabular-nums tracking-wide',
      lossless ? 'bg-brand/15 text-brand' : 'bg-foreground/10 text-foreground/70',
      className,
    )}>
      {lossless && <AudioLines className="size-3" />}
      {lossless ? 'Lossless' : codec}
      <span className="opacity-70">{[lossless ? codec : null, ...detail].filter(Boolean).join(' · ')}</span>
    </span>
  )
}
