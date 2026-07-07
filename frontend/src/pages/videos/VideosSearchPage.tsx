import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueries, useQuery } from '@tanstack/react-query'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'
import { getVideoSources, searchSource, type HubVideoItem, type VideoSource } from '@/lib/videos/api'
import { SOURCE_META } from '@/lib/videos/sources'

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
