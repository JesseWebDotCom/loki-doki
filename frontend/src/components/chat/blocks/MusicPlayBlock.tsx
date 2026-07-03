import { Music, Play, ExternalLink } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { proxyImg } from '@/lib/img'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { Card } from '@/components/ui/card'
import type { PlayMusicBlockData, PlayMusicVideo } from './types'

function fmtDur(sec: number | null): string {
  if (!sec) return ''
  const m = Math.floor(sec / 60)
  const s = String(Math.round(sec % 60)).padStart(2, '0')
  return `${m}:${s}`
}

export function MusicPlayBlock({ data }: { data: PlayMusicBlockData }) {
  const navigate = useNavigate()
  const { playExpanded } = useYoutubePlayback()
  const top = data.videos[0]

  // Click a result → play it in the global mini-player, in place (no navigation),
  // matching how the companion starts playback.
  function playVideo(v: PlayMusicVideo) {
    playExpanded({
      videoId: v.videoId,
      title: v.title,
      author: v.artist ?? null,
      thumbnail: v.thumbnail,
      durationSec: v.durationSec,
    })
  }

  return (
    <Card variant="surface" className="bg-card/60">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex size-6 items-center justify-center rounded-control bg-brand/10 text-brand">
          <Music className="size-3.5" />
        </div>
        <span className="text-xs font-semibold text-muted-foreground">Music</span>
      </div>

      {/* Top result */}
      {top && (
        <button
          type="button"
          onClick={() => playVideo(top)}
          className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/40"
        >
          <div className="relative shrink-0">
            <img
              src={proxyImg(top.thumbnail)}
              alt={top.title}
              className="h-12 w-[85px] rounded-card object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
            <div className="absolute inset-0 flex items-center justify-center rounded-card bg-black/30 opacity-0 transition-opacity hover:opacity-100">
              <Play className="size-4 fill-white text-white" />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{top.title}</p>
            {top.artist && <p className="truncate text-xs text-muted-foreground">{top.artist}</p>}
            {top.durationSec && <p className="text-[11px] text-muted-foreground">{fmtDur(top.durationSec)}</p>}
          </div>
          <Play className="size-4 shrink-0 text-muted-foreground" />
        </button>
      )}

      {/* More results */}
      {data.videos.length > 1 && (
        <div className="divide-y divide-border/40 border-t border-border/60">
          {data.videos.slice(1).map((v) => (
            <button
              key={v.videoId}
              type="button"
              onClick={() => playVideo(v)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/30"
            >
              <img
                src={proxyImg(v.thumbnail)}
                alt={v.title}
                className="h-8 w-14 shrink-0 rounded-control object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{v.title}</p>
                {v.artist && <p className="truncate text-[11px] text-muted-foreground">{v.artist}</p>}
              </div>
              {v.durationSec && <span className="shrink-0 text-[11px] text-muted-foreground">{fmtDur(v.durationSec)}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Open Music app link */}
      <div className="border-t border-border/60 px-3 py-2">
        <button
          type="button"
          onClick={() => navigate(data.deeplink)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="size-3" />
          Open in Music app
        </button>
      </div>
    </Card>
  )
}
