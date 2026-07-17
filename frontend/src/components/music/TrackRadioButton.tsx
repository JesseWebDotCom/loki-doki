// "Start Track Radio" - one tap builds an ordered queue of similar tracks off this song
// (household-collection sound similarity, station-engine fallback) and starts playing it.
// Drop into any track row alongside AddToPlaylistButton/SongDownloadButton.

import { useState } from 'react'
import { toast } from 'sonner'
import { Radio } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import { getTrackRadio } from '@/lib/music/intelApi'
import { Spinner } from '@/components/ui/spinner'

export interface TrackRadioSeed { videoId: string; title: string; artist?: string | null }

/** Shared start logic (also used by the Now Playing overflow menu). */
export async function startTrackRadio(
  radio: ReturnType<typeof useRadio>,
  seed: TrackRadioSeed,
): Promise<boolean> {
  try {
    const r = await getTrackRadio({ ref: seed.videoId, title: seed.title, artist: seed.artist })
    if (!r.tracks.length) {
      toast.error('Could not build a radio for this song')
      return false
    }
    radio.playPlaylist(
      r.tracks.map(t => ({ videoId: t.videoId, title: t.title, author: t.artist || null, thumbnail: '' })),
      0,
      { name: `${seed.title} Radio` },
    )
    toast.success(r.source === 'similarity'
      ? `${seed.title} Radio: similar songs from your collection`
      : `${seed.title} Radio started`)
    return true
  } catch {
    toast.error('Could not start Track Radio')
    return false
  }
}

export function TrackRadioButton({ videoId, title, artist, className }: TrackRadioSeed & { className?: string }) {
  const radio = useRadio()
  const [busy, setBusy] = useState(false)
  return (
    <button type="button" aria-label="Start Track Radio" title="Start Track Radio: play similar songs"
      disabled={busy}
      onClick={async e => {
        e.stopPropagation()
        if (busy) return
        setBusy(true)
        try { await startTrackRadio(radio, { videoId, title, artist }) } finally { setBusy(false) }
      }}
      className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition',
        'opacity-0 hover:bg-accent/60 hover:text-brand focus-visible:opacity-100 group-hover:opacity-100',
        busy && 'opacity-100', className)}>
      {busy ? <Spinner size="sm" /> : <Radio className="size-4" />}
    </button>
  )
}
