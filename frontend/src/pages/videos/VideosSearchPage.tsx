import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueries, useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'
import { getVideoSources, searchSource, semanticSearch, type HubVideoItem, type VideoSource } from '@/lib/videos/api'
import { SOURCE_META } from '@/lib/videos/sources'
import { proxyImg } from '@/lib/img'
import { cn } from '@/lib/cn'

function fmtSeek(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** "Moments from your library": semantic matches over everything the household watched,
 *  each linking straight to the matching timestamp. */
function LibraryMoments({ q }: { q: string }) {
  const { data } = useQuery({
    queryKey: ['videos-semantic', q],
    queryFn: () => semanticSearch(q),
    enabled: q.length >= 3,
    staleTime: 60_000,
  })
  const hits = (data?.hits ?? []).filter((h) => h.score > 0.45).slice(0, 6)
  if (hits.length === 0) return null
  return (
    <section className="mb-8">
      <SectionHeader title="Moments from your library" className="mb-3" />
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {hits.map((h) => (
          <Link key={`${h.source}:${h.videoId}:${h.seekSec ?? -1}`}
            to={`/videos/${h.source}/watch/${encodeURIComponent(h.videoId)}${h.seekSec != null ? `?t=${h.seekSec}` : ''}`}
            className={cn('flex gap-3 rounded-card border border-border/60 bg-card/60 p-2.5 transition-colors hover:border-brand/40')}>
            {h.thumbnailUrl ? (
              <img src={proxyImg(h.thumbnailUrl)} alt="" loading="lazy" className="h-14 w-24 shrink-0 rounded-control object-cover bg-muted" />
            ) : (
              <div className="grid h-14 w-24 shrink-0 place-items-center rounded-control bg-muted"><History className="size-4 text-muted-foreground" /></div>
            )}
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 text-xs font-semibold">{h.title}</p>
              {h.snippet && <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">“…{h.snippet.slice(0, 140)}…”</p>}
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {h.seekSec != null ? `Jump to ${fmtSeek(h.seekSec)}` : h.creatorName ?? SOURCE_META[h.source].label}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}

/** Round-robin interleave so every searched source is represented evenly near the top. */
function interleave(lists: HubVideoItem[][]): HubVideoItem[] {
  const out: HubVideoItem[] = []
  const seen = new Set<string>()
  const max = lists.reduce((m, l) => Math.max(m, l.length), 0)
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      const it = list[i]
      if (it && !seen.has(`${it.source}:${it.id}`)) { seen.add(`${it.source}:${it.id}`); out.push(it) }
    }
  }
  return out
}

/** Cross-source search: queries every searchable source at once (TikTok has no search API),
 *  interleaves the results, and lets you narrow the scope to one source with the filter. */
export function VideosSearchPage() {
  const [params] = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  const [view, setView] = useViewPreference('videos.search_view', 'grid')
  const [scope, setScope] = useState<VideoSource | 'all'>('all')

  const { data: sourcesData } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources, staleTime: 5 * 60_000 })
  const searchable = useMemo(
    () => (sourcesData?.sources ?? []).filter((s) => s.enabled && s.capabilities.search).map((s) => s.source),
    [sourcesData],
  )
  const targets = scope === 'all' ? searchable : searchable.filter((s) => s === scope)

  const results = useQueries({
    queries: targets.map((s) => ({
      queryKey: ['videos-search', s, q],
      queryFn: () => searchSource(s, q),
      enabled: !!q,
      staleTime: 5 * 60_000,
    })),
  })
  const loading = results.some((r) => r.isLoading)
  const dataKey = results.map((r) => (r.data ? r.data.items.length : -1)).join(',')
  const items = useMemo(
    () => interleave(results.map((r) => r.data?.items ?? [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataKey],
  )

  if (!q) {
    return (
      <PageContainer width="wide" className="py-6">
        <p className="py-24 text-center text-sm text-muted-foreground">Type something in the search bar to search across your sources.</p>
      </PageContainer>
    )
  }

  return (
    <PageContainer width="wide" className="py-6">
      <SectionHeader title={`Results for “${q}”`} className="mb-4" />
      <LibraryMoments q={q} />
      <div className="mb-6 flex items-center gap-3">
        <ChipRow className="mb-0 min-w-0 flex-1">
          <Chip label="All sources" active={scope === 'all'} onClick={() => setScope('all')} />
          {searchable.map((s) => (
            <Chip key={s} label={SOURCE_META[s].label} active={scope === s}
              activeClassName={SOURCE_META[s].pillActiveClass} onClick={() => setScope(s)} />
          ))}
        </ChipRow>
        <ViewToggle value={view} onChange={setView} className="shrink-0" />
      </div>
      {loading && items.length === 0 ? (
        <SkeletonCards count={12} className="xl:grid-cols-4" />
      ) : items.length > 0 ? (
        <HubVideoCollection items={items} view={view} showSource />
      ) : (
        <p className="py-20 text-center text-sm text-muted-foreground">
          No results{scope !== 'all' ? ` on ${SOURCE_META[scope].label}` : ''} for “{q}”.
        </p>
      )}
    </PageContainer>
  )
}
