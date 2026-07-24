// Branded full-screen slate for offair/filler/error moments: channel identity gradient,
// logo monogram tile, message, and (for filler) the up-next line with a live clock.

import { useEffect, useState } from 'react'
import { MoonStar, Clock } from 'lucide-react'
import { tvGlyph, type TvChannel } from '@/lib/dokitv/api'

interface TvSlateProps {
  channel: TvChannel
  headline: string
  message?: string | null
  nextTitle?: string | null
  variant?: 'default' | 'signoff'
}

export function TvSlate({ channel, headline, message, nextTitle, variant = 'default' }: TvSlateProps) {
  const Glyph = tvGlyph(channel.glyph)
  const [clock, setClock] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-6 px-8 text-center"
      style={{ background: `radial-gradient(ellipse at center, ${channel.colorDark} 0%, #030303 75%)` }}
    >
      <div
        className="flex size-24 items-center justify-center rounded-sheet shadow-2xl"
        style={{ background: `linear-gradient(135deg, ${channel.color}, ${channel.colorDark})` }}
      >
        {variant === 'signoff' ? <MoonStar className="size-12 text-white" /> : <Glyph className="size-12 text-white" />}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/50">
          {channel.number} {channel.name}
        </p>
        <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">{headline}</h2>
        {message ? <p className="mx-auto max-w-md text-sm text-white/60">{message}</p> : null}
      </div>
      {nextTitle ? (
        <div className="flex items-center gap-2 rounded-full bg-black/30 px-4 py-2 text-sm font-semibold text-white/80">
          <Clock className="size-4" />
          Up next: {nextTitle}
        </div>
      ) : null}
      <p className="text-sm tabular-nums text-white/40">
        {clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </p>
    </div>
  )
}
