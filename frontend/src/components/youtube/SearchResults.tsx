import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Search, Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { search as ytSearch, type SearchResult, type PlaylistSearchResult, type SearchType } from '@/lib/youtube/api'
import { searchToItem, savedToItem } from '@/lib/youtube/types'
import { qualityBadge } from '@/lib/youtube/format'
import { useYtDownloads } from '@/lib/youtube/useData'
import { ChannelAvatar } from '@/components/youtube/media'
import { VideoCard } from '@/components/youtube/VideoCard'
import { ChannelRail, HScroll, PlaylistCard, type ChannelEntry } from '@/components/youtube/shelves'
import { useYoutubeModeOptional } from '@/components/youtube/YoutubeLayout'

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'
const FILTERS: [SearchType, string][] = [['all', 'All'], ['videos', 'Videos'], ['shorts', 'Shorts'], ['playlists', 'Playlists'], ['channels', 'Channels']]

/** YouTube search results — rendered on the Home route when there's a `?q=` query.
 *  (Formerly the Discover page; Discover was merged into Home.) */
export function SearchResults({ q }: { q: string }) {
  const [type, setType] = useState<SearchType>('all')
  const online = useYoutubeModeOptional() === 'online'
  const { data: downloads = [] } = useYtDownloads()

  const { data, isLoading, error } = useQuery({
    queryKey: ['yt-search', q, type],
    queryFn: () => ytSearch(q, null, type),
    enabled: q.length > 0 && online,
  })

  // Offline: search the saved library by title rather than hitting YouTube.
  const offlineItems = useMemo(() => {
    if (online) return []
    const needle = q.toLowerCase()
    return downloads
      .filter(r => r.status === 'ready' && (r.title || r.videoId).toLowerCase().includes(needle))
      .map(r => savedToItem(r, qualityBadge(r.kind, r.maxHeight)))
  }, [online, downloads, q])

  // Extra pages loaded via the InnerTube continuation token ("Load more").
  const [more, setMore] = useState<SearchResult[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => { setMore([]); setCursor(data?.continuation ?? null) }, [data])
  // Reset the filter when the query changes.
  useEffect(() => { setType('all') }, [q])

  async function loadMore() {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const page = await ytSearch(q, cursor, type)
      setMore(prev => [...prev, ...(page.results ?? [])])
      setCursor(page.continuation ?? null)
    } catch { toast.error('Could not load more') } finally { setLoadingMore(false) }
  }

  // Dedupe accumulated pages against the first page by video id.
  const seen = new Set<string>()
  const results = [...(data?.results ?? []), ...more].filter(r => !seen.has(r.videoId) && seen.add(r.videoId))
  const items = results.map(searchToItem)
  const channels: ChannelEntry[] = (data?.channels ?? []).map(c => ({
    id: c.channelId, title: c.title, thumbnailUrl: c.thumbnailUrl, subtitle: c.subscribers ?? c.handle ?? undefined,
  }))
  const playlists = data?.playlists ?? []
  const empty = !isLoading && !results.length && !channels.length && !playlists.length

  if (!online) {
    return (
      <div className="mx-auto max-w-[1500px] space-y-6 px-4 py-6 sm:px-6">
        <h1 className="text-xl font-bold tracking-tight">Results for “{q}”</h1>
        {offlineItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Search className="mb-3 size-10 opacity-30" /><p className="text-sm">Nothing saved offline matches “{q}”</p>
          </div>
        ) : (
          <div className={GRID}>{offlineItems.map(i => <VideoCard key={i.videoId + (i.localKind ?? '')} item={i} />)}</div>
        )}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 px-4 py-6 sm:px-6">
      <h1 className="text-xl font-bold tracking-tight">Results for “{q}”</h1>
      <ChipRow>
        {FILTERS.map(([k, label]) => <Chip key={k} label={label} active={type === k} onClick={() => setType(k)} />)}
      </ChipRow>

      {isLoading ? (
        <div className="flex h-[40vh] items-center justify-center"><Loader2 className="size-7 animate-spin text-muted-foreground" /></div>
      ) : empty ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Search className="mb-3 size-10 opacity-30" /><p className="text-sm">No {type === 'all' ? 'results' : type} found</p>
        </div>
      ) : type === 'channels' ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {channels.map(c => (
            <Link key={c.id} to={`/youtube/channel/${encodeURIComponent(c.id)}`} state={{ title: c.title, thumbnailUrl: c.thumbnailUrl }}
              className="group flex items-center gap-3 rounded-xl border border-border/50 bg-card/40 p-3 transition hover:border-[var(--yt-accent)]">
              <ChannelAvatar title={c.title} src={c.thumbnailUrl} className="size-14 shrink-0 text-xl ring-1 ring-border/40" />
              <div className="min-w-0"><p className="truncate text-sm font-semibold">{c.title}</p>{c.subtitle && <p className="truncate text-xs text-muted-foreground">{c.subtitle}</p>}</div>
            </Link>
          ))}
        </div>
      ) : type === 'playlists' ? (
        <div className={GRID}>{playlists.map(p => <PlaylistCard key={p.playlistId} p={p} />)}</div>
      ) : (
        <div className="space-y-8">
          {type === 'all' && channels.length > 0 && <ChannelRail title="Channels" channels={channels} />}
          {type === 'all' && playlists.length > 0 && <PlaylistRail playlists={playlists} />}
          {items.length > 0 && (
            <section className="space-y-3">
              {type === 'all' && (channels.length > 0 || playlists.length > 0) && <h2 className="text-lg font-bold tracking-tight">Videos</h2>}
              <div className={GRID}>{items.map(i => <VideoCard key={i.videoId} item={i} />)}</div>
              {cursor && (
                <div className="flex justify-center pt-2">
                  <button onClick={loadMore} disabled={loadingMore}
                    className="flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold transition hover:border-[var(--yt-accent)] disabled:opacity-60">
                    {loadingMore && <Loader2 className="size-4 animate-spin" />} Load more
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      )}
      {error ? <p className="text-sm text-destructive">Search failed.</p> : null}
    </div>
  )
}

// A horizontal rail of playlist cards linking to the playlist browse page.
function PlaylistRail({ playlists }: { playlists: PlaylistSearchResult[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold tracking-tight">Playlists</h2>
      <HScroll>
        {playlists.map(p => <div key={p.playlistId} className="w-60 shrink-0"><PlaylistCard p={p} /></div>)}
      </HScroll>
    </section>
  )
}
