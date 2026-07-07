import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Mic, Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { ytImageProxy } from '@/lib/youtube/api'
import { proxyImg } from '@/lib/img'
import { getShows } from '@/lib/podcast/api'
import { ShowCover } from '@/components/podcast/ShowCover'
import { ShowEditorDialog } from '@/components/podcast/ShowEditorDialog'

// `source` + `url` let non-YouTube videos (TikTok/Vimeo/…) resolve a transcript server-side;
// omitted for plain YouTube refs.
export interface PodcastSourceVideo { videoId: string; title?: string; author?: string; source?: string; url?: string }

/**
 * A "Podcast" dropdown for a YouTube source (channel or playlist): create a new podcast
 * from it (full show editor) or jump to any podcast already made from this source.
 * Continuing a podcast ("generate next batch") lives on the show page, not here.
 */
export function PodcastSourceButtons({ videos, sourceId, suggestedShowName, sourceDescription, coverImageUrl }: {
  videos: PodcastSourceVideo[]
  /** Stable key for this source, e.g. `channel:<id>` or `playlist:<id>`. */
  sourceId: string
  suggestedShowName?: string
  /** Channel/playlist "about" text, woven into the auto-generated show description. */
  sourceDescription?: string
  /** Raw source photo URL (channel avatar / thumbnail) for cover art. */
  coverImageUrl?: string
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  // Podcasts already made from this source, found by their server-side sourceRef.
  const { data: shows = [] } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows })
  const related = shows.filter(s => s.isOwn && s.sourceRef === sourceId)
  // Light the button up when a linked show is auto-generating new episodes from this source.
  const autoGenerating = related.some(s => s.autoGenerate)

  // No videos to build from: keep the button for layout balance, just disabled.
  if (videos.length === 0) {
    return (
      <Button variant="outline" size="icon" disabled aria-label="Make a podcast" title="No videos available to make a podcast from"
        className="size-10 text-foreground/80">
        <Mic className="size-4" />
      </Button>
    )
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" aria-label="Make a podcast" title={autoGenerating ? 'Auto-generating a podcast from this channel' : 'Make a podcast from this channel'}
            className={cn('size-10',
              autoGenerating
                ? 'bg-[var(--yt-accent)] text-white hover:bg-[var(--yt-accent-hover)]'
                : 'border border-border bg-background text-foreground/80 hover:bg-background hover:text-foreground')}>
            <Mic className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => setOpen(true)}><Plus className="size-4" /> Create podcast</DropdownMenuItem>
          {related.length > 0 && <DropdownMenuSeparator />}
          {related.length > 0 && <DropdownMenuLabel>From this {sourceId.startsWith('playlist:') ? 'playlist' : 'channel'}</DropdownMenuLabel>}
          {related.map(s => (
            <DropdownMenuItem key={s.id} onSelect={() => navigate(`/podcasts/show/${s.id}`)}>
              <ShowCover showId={s.id} title={s.name} size={22} rounded="rounded" />
              <span className="truncate">{s.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <ShowEditorDialog open={open} onClose={() => setOpen(false)}
        youtube={{
          videos, sourceRef: sourceId,
          // Cover art proxied through the source's own image proxy — hub avatars (TikTok/Vimeo)
          // aren't on Google's CDN, so ytImageProxy would drop them.
          coverImageUrl: coverImageUrl ? ((videos[0]?.source ?? 'youtube') === 'youtube' ? ytImageProxy(coverImageUrl) : proxyImg(coverImageUrl)) : undefined,
          sourceName: suggestedShowName, sourceDescription,
        }}
        presetName={suggestedShowName ? `${suggestedShowName} Podcast` : undefined} />
    </>
  )
}
