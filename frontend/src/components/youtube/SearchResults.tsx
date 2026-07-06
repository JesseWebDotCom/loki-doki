import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { search as ytSearch, type SearchResult, type PlaylistSearchResult, type SearchType, type ChannelSearchResult } from '@/lib/youtube/api'
import { searchToItem, savedToItem } from '@/lib/youtube/types'
import { qualityBadge } from '@/lib/youtube/format'
import { useYtDownloads } from '@/lib/youtube/useData'
import { ChannelAvatar } from '@/components/youtube/media'
import { VideoCollection, YT_GRID as GRID } from '@/components/youtube/VideoCollection'
import { ChannelRail, HScroll, PlaylistCard, PlaylistListRow, type ChannelEntry } from '@/components/youtube/shelves'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { useYoutubeModeOptional } from '@/components/videos/VideosLayout'
const FILTERS: [SearchType, string][] = [['all', 'All'], ['videos', 'Videos'], ['shorts', 'Shorts'], ['playlists', 'Playlists'], ['channels', 'Channels']]

/** YouTube search results, rendered on the Home route when there's a `?q=` query.
 *  (Formerly the Discover page; Discover was merged into Home.) */
export function SearchResults({ q }: { q: string }) {
  const [type, setType] = useState<SearchType>('all')
  const [view, setView] = useViewPreference('youtube.search_view', 'grid')
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
  const [moreChannels, setMoreChannels] = useState<ChannelSearchResult[]>([])
  const [morePlaylists, setMorePlaylists] = useState<PlaylistSearchResult[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => { setMore([]); setMoreChannels([]); setMorePlaylists([]); setCursor(data?.continuation ?? null) }, [data])
  // Reset the filter when the query changes.
  useEffect(() => { setType('all') }, [q])

  async function loadMore() {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const page = await ytSearch(q, cursor, type)
      setMore(prev => [...prev, ...(page.results ?? [])])
      setMoreChannels(prev => [...prev, ...(page.channels ?? [])])
      setMorePlaylists(prev => [...prev, ...(page.playlists ?? [])])
      setCursor(page.continuation ?? null)
    } catch { toast.error('Could not load more') } finally { setLoadingMore(false) }
  }

  // Dedupe accumulated pages against the first page by video id.
  const seen = new Set<string>()
  const results = [...(data?.results ?? []), ...more].filter(r => !seen.has(r.videoId) && seen.add(r.videoId))
  const items = results.map(searchToItem)
  const seenChannels = new Set<string>()
  const channels: ChannelEntry[] = [...(data?.channels ?? []), ...moreChannels]
    .filter(c => !seenChannels.has(c.channelId) && seenChannels.add(c.channelId))
    .map(c => ({ id: c.channelId, title: c.title, thumbnailUrl: c.thumbnailUrl, subtitle: c.subscribers ?? c.handle ?? undefined }))
  const seenPlaylists = new Set<string>()
  const playlists = [...(data?.playlists ?? []), ...morePlaylists].filter(p => !seenPlaylists.has(p.playlistId) && seenPlaylists.add(p.playlistId))
  const empty = !isLoading && !results.length && !channels.length && !playlists.length

  if (!online) {
    return (
      <PageContainer width="wide" className="space-y-6 py-6">
        <h2 className="text-title">Results for “{q}”</h2>
        {offlineItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Search className="mb-3 size-10 opacity-30" /><p className="text-sm">Nothing saved offline matches “{q}”</p>
          </div>
        ) : (
          <>
            <div className="flex justify-end"><ViewToggle value={view} onChange={setView} className="shrink-0" /></div>
            <VideoCollection items={offlineItems} view={view} />
          </>
        )}
      </PageContainer>
    )
  }

  return (
    <PageContainer width="wide" className="space-y-6 py-6">
      <h2 className="text-title">Results for “{q}”</h2>
      <div className="flex items-center gap-3">
        <ChipRow className="min-w-0 flex-1">
          {FILTERS.map(([k, label]) => <Chip key={k} label={label} active={type === k} onClick={() => setType(k)} />)}
        </ChipRow>
        {type !== 'channels' && <ViewToggle value={view} onChange={setView} className="shrink-0" />}
      </div>

      {isLoading ? (
        <SkeletonCards count={8} className="xl:grid-cols-4" />
      ) : empty ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Search className="mb-3 size-10 opacity-30" /><p className="text-sm">No {type === 'all' ? 'results' : type} found</p>
        </div>
      ) : type === 'channels' ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
            {channels.map(c => (
              <Link key={c.id} to={`/videos/youtube/channel/${encodeURIComponent(c.id)}`} state={{ title: c.title, thumbnailUrl: c.thumbnailUrl }}
                className="group flex items-center gap-3 rounded-card border border-border bg-card p-3 transition hover:border-[var(--yt-accent)]">
                <ChannelAvatar title={c.title} src={c.thumbnailUrl} className="size-14 shrink-0 text-xl ring-1 ring-border/40" />
                <div className="min-w-0"><p className="truncate text-sm font-semibold">{c.title}</p>{c.subtitle && <p className="truncate text-xs text-muted-foreground">{c.subtitle}</p>}</div>
              </Link>
            ))}
          </div>
          <LoadMore cursor={cursor} loading={loadingMore} onClick={loadMore} />
        </>
      ) : type === 'playlists' ? (
        <>
          {view === 'list'
            ? <div className="space-y-1">{playlists.map(p => <PlaylistListRow key={p.playlistId} p={p} />)}</div>
            : <div className={GRID}>{playlists.map(p => <PlaylistCard key={p.playlistId} p={p} />)}</div>}
          <LoadMore cursor={cursor} loading={loadingMore} onClick={loadMore} />
        </>
      ) : (
        <div className="space-y-8">
          {type === 'all' && channels.length > 0 && <ChannelRail title="Channels" channels={channels} />}
          {type === 'all' && playlists.length > 0 && <PlaylistRail playlists={playlists} />}
          {items.length > 0 && (
            <section className="space-y-3">
              {type === 'all' && (channels.length > 0 || playlists.length > 0) && <SectionHeader title="Videos" />}
              <VideoCollection items={items} view={view} />
              <LoadMore cursor={cursor} loading={loadingMore} onClick={loadMore} />
            </section>
          )}
        </div>
      )}
      {error ? <p className="text-sm text-destructive">Search failed.</p> : null}
    </PageContainer>
  )
}

function LoadMore({ cursor, loading, onClick }: { cursor: string | null; loading: boolean; onClick: () => void }) {
  if (!cursor) return null
  return (
    <div className="flex justify-center pt-2">
      <Button variant="outline" onClick={onClick} disabled={loading}
        className="h-auto px-5 py-2.5 font-semibold hover:border-[var(--yt-accent)]">
        {loading && <Spinner />} Load more
      </Button>
    </div>
  )
}

// A horizontal rail of playlist cards linking to the playlist browse page.
function PlaylistRail({ playlists }: { playlists: PlaylistSearchResult[] }) {
  return (
    <section className="space-y-3">
      <SectionHeader title="Playlists" />
      <HScroll>
        {playlists.map(p => <div key={p.playlistId} className="w-60 shrink-0"><PlaylistCard p={p} /></div>)}
      </HScroll>
    </section>
  )
}
