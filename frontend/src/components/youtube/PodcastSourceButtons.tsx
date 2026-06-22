import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Mic, Plus, ChevronDown } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { ytImageProxy } from '@/lib/youtube/api'
import { getShows } from '@/lib/podcast/api'
import { ShowCover } from '@/components/podcast/ShowCover'
import { ShowEditorDialog } from '@/components/podcast/ShowEditorDialog'

export interface PodcastSourceVideo { videoId: string; title?: string; author?: string }

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
  /** Channel/playlist "about" text — woven into the auto-generated show description. */
  sourceDescription?: string
  /** Raw source photo URL (channel avatar / thumbnail) for cover art. */
  coverImageUrl?: string
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  // Podcasts already made from this source, found by their server-side sourceRef.
  const { data: shows = [] } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows })
  const related = shows.filter(s => s.isOwn && s.sourceRef === sourceId)

  // No videos to build from — keep the button for layout balance, just disabled.
  if (videos.length === 0) {
    return (
      <button type="button" disabled title="No videos available to make a podcast from"
        className="flex cursor-not-allowed items-center gap-1.5 rounded-full border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground/80 opacity-50">
        <Mic className="size-4" /> Podcast <ChevronDown className="size-3.5 opacity-70" />
      </button>
    )
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-1.5 rounded-full border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground/80 transition-colors hover:text-foreground">
            <Mic className="size-4" /> Podcast <ChevronDown className="size-3.5 opacity-70" />
          </button>
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
          coverImageUrl: coverImageUrl ? ytImageProxy(coverImageUrl) : undefined,
          sourceName: suggestedShowName, sourceDescription,
        }}
        presetName={suggestedShowName ? `${suggestedShowName} Podcast` : undefined} />
    </>
  )
}
